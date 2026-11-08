# Arquitetura

Decisões técnicas do processador de apostas, com motivo e trade-off.
Cada seção indica a fase em que foi tomada; seções futuras serão adicionadas conforme o `PROGRESSO.md`.

---

## 1. Runtime e estrutura (Fase 0)

- **Bun 1.4** como runtime, gerenciador de pacotes e test runner. O Bun executa TypeScript direto, sem build; `bun run typecheck` (`tsc --noEmit`) é quem garante os tipos, já que o Bun não checa tipos.
  - *Trade-off:* um passo a mais para lembrar (typecheck separado do teste), em troca de ciclo de execução sem build.
- **TypeScript estrito**, incluindo `noUncheckedIndexedAccess` e `exactOptionalPropertyTypes`: acesso a índice devolve `T | undefined` e opcional não aceita `undefined` implícito — relevante para não deixar valores monetários ou ids "sumirem" silenciosamente.
- **Camadas** (`domain` → `application` → `infrastructure` / `interfaces`): o domínio não importa NestJS nem ORM. Portas (interfaces) ficam em `application/ports`; adaptadores em `infrastructure`. Lógica de aplicação sem framework (ex.: `ReadinessService`) fica em `application` e é instanciada pelos módulos Nest via factory.
- **Configuração** validada no boot (`loadConfig`): variável ausente ou inválida derruba o processo antes de aceitar tráfego, reportando todos os problemas de uma vez (inclusive credenciais AWS pela metade, que fariam o SDK cair silenciosamente na cadeia padrão).
- **Módulos Nest** por responsabilidade, e o `AppModule` só compõe:

  | Módulo | Fornece / exporta |
  |---|---|
  | `ConfigModule` (global) | `APP_CONFIG`, a config já validada |
  | `PersistenceModule` | MikroORM + `PostgresReadinessCheck` |
  | `MessagingModule` | `SQSClient` (e o fecha no shutdown) + `SqsReadinessCheck` |
  | `HealthModule` | controller de health + `ReadinessService` |

  O `AppModule.register(config)` recebe a config pronta, o que permite aos testes subir a aplicação contra outro banco/endpoint sem mexer em `process.env`. Consumidor SQS, outbox publisher e workers das próximas fases importam `MessagingModule`/`PersistenceModule` em vez de crescer o módulo raiz.

## 2. ORM: MikroORM 6 (Fase 0)

**Escolha:** MikroORM, opção preferencial do desafio.

**Motivo:** Unit of Work e Identity Map explícitos, `em.transactional()` e `LockMode` (pessimista/otimista) nativos — exatamente as ferramentas que a estratégia de concorrência por wallet vai precisar.

**Mapeamento sem decorators no domínio:** as entidades serão mapeadas com `EntitySchema` dentro de `infrastructure/persistence`. As classes de domínio continuam com construtor `private` e factories, sem nenhum import de ORM (CHALLENGE §6.1).
- *Trade-off:* `EntitySchema` é mais verboso que decorators e o mapeamento fica longe da classe. Aceito em troca de um domínio testável sem ORM.

**Contexto do EntityManager — uma regra só para todas as entradas:**
- `allowGlobalContext: false` proíbe usar o `EntityManager` global (identity map compartilhado entre requisições).
- `registerRequestContext: false` desliga o contexto implícito por request HTTP do `@mikro-orm/nestjs`.
- Resultado: HTTP, consumidor SQS e workers seguem a mesma regra — todo use case abre o próprio contexto (`em.fork()` / `em.transactional()`).
- *Trade-off:* um pouco mais de cerimônia em cada use case, em troca de não haver comportamento diferente entre a entrada HTTP (que teria contexto "de graça") e os workers (que lançariam erro).

**Conexão preguiçosa (`connect: false`, só na aplicação):** a instância sobe mesmo com o Postgres fora; o `/health/ready` reporta `not_ready` e o tráfego não chega até o banco voltar.
- *Motivo:* com conexão eager, uma queda do banco derruba o boot de todas as instâncias, que entram em crash loop (CHALLENGE §3: "PostgreSQL e SQS podem ficar temporariamente indisponíveis").
- *Trade-off:* uma `DATABASE_URL` errada não falha no boot — aparece no readiness. O CLI de migrations continua com conexão eager (falha rápido).

**Pool:** `max: 10` por instância e `acquireTimeoutMillis: 10s`.
- Com N instâncias o total é N × 10; o `max_connections` do Postgres (100 por padrão) comporta folgadamente 3+ instâncias mais workers.
- O acquire timeout curto faz requisições falharem como erro transitório quando o banco está fora, em vez de empilharem por 60s (default do tarn).
- *Trade-off:* sob contenção extrema de pool, uma requisição pode falhar em vez de esperar mais — preferível a acumular latência sem limite.

## 3. Migrations (Fase 0)

- Executadas por um CLI próprio (`src/infrastructure/persistence/migrate.ts`) que usa `orm.getMigrator()` programaticamente. **Motivo:** não depender do CLI do MikroORM rodando sob Bun (resolução de config TS, ts-node etc.).
  - Argumentos são validados **antes** de conectar ao banco: comando/opção desconhecida ou nome inválido saem com código 1 e a mensagem de uso.
  - O nome da migration vira parte do nome da classe TS, então só aceita `[A-Za-z0-9_]` — um `add-wallets` geraria um arquivo que quebra todas as migrations.
  - *Trade-off:* mais um pedaço de código para manter, em vez do CLI pronto do ORM.
- **Escritas à mão em SQL** (`snapshot: false`, sem geração por diff). O schema — constraints, índices, triggers — é parte do que é avaliado, e precisa ser explícito e revisável, não derivado das entidades.
  - *Trade-off:* nada detecta automaticamente divergência entre o `EntitySchema` e o SQL; isso fica a cargo dos testes de integração contra o banco real.
- `transactional: true` + `allOrNothing: true`: um lote de migrations aplica inteiro ou nada.
- Toda migration tem `down`. O ciclo up → down → up é testado em `test/integration/infrastructure/migrations.test.ts`, e o CLI em `migrate-cli.test.ts`.
- A migration `baseline` é intencionalmente vazia: só prova o ciclo. As tabelas nascem na Fase 2, e aí o teste passa a verificar que o `down` remove de fato o schema.

## 4. Infraestrutura local (Fase 0)

| Serviço | Imagem | Observação |
|---|---|---|
| PostgreSQL | `postgres:16.10-alpine` | init cria o banco `wagering_test`, isolado do banco de dev |
| LocalStack | `localstack/localstack:4.9.2` | só SQS; versão fixada |

- **Portas publicadas só em `127.0.0.1`:** as credenciais locais são fixas e conhecidas; não expor Postgres e a fila de entrada de transações para a rede.
- **LocalStack com versão fixa:** versões recentes da imagem passaram a exigir auth token. A 4.9.2 roda sem conta.
  - *Trade-off:* sem correções e novidades de versões futuras. Alternativa registrada caso deixe de funcionar: **MiniStack**, aceito pelo desafio.
- **Healthcheck do LocalStack** só fica verde quando o init terminou **e** todos os scripts terminaram com `SUCCESSFUL`. Só `"completed": true` não basta: um script com erro também completa. Assim `docker compose up --wait` garante que as filas existem.
- **`.gitattributes` força LF:** no Windows o Git converteria o script de init para CRLF e o bash do container quebraria.
- **Testes** usam `.env.test` (carregado automaticamente pelo `bun test`, que define `NODE_ENV=test`). O arquivo é completo por conta própria — não depende do `.env` do desenvolvedor — e é versionado com **somente** valores locais.

## 5. Filas SQS (Fase 0)

| Fila | Atributos |
|---|---|
| `wager-transactions-dlq.fifo` | FIFO, `ContentBasedDeduplication=false`, retenção de 14 dias |
| `wager-transactions.fifo` | FIFO, `ContentBasedDeduplication=false`, `VisibilityTimeout=30s`, `RedrivePolicy` → DLQ com `maxReceiveCount=10` |
| `wager-events.fifo` (Fase 6) | FIFO, `ContentBasedDeduplication=false`, retenção de 14 dias, **sem DLQ**: destino do outbox publisher (§19) |

- **Nomes:** `SQS_WAGER_QUEUE_NAME` / `SQS_WAGER_DLQ_NAME`, lidos pela aplicação **e** repassados pelo compose ao script de init, com os mesmos defaults (os nomes do CHALLENGE §10). Uma única fonte evita a aplicação procurar uma fila que o init nunca criou.
- **Sem dedup por conteúdo:** o produtor informa `MessageDeduplicationId` explícito. De qualquer forma, a dedup do broker é **otimização**; a garantia é a inbox persistente no Postgres (CHALLENGE §8).
  - *Trade-off:* todo produtor precisa gerar o dedup id; em troca, dois payloads idênticos legítimos não são descartados pelo broker por coincidência de conteúdo.
- **`maxReceiveCount=10`** (era 5 na Fase 0; revisto na Fase 5): rede de segurança acima do limite do consumidor (5). Motivo em §18. Configurável por `SQS_MAX_RECEIVE_COUNT` (lido pelo compose; mudar exige recriar o container do LocalStack).
  - *Trade-off:* baixo demais manda para a DLQ mensagens que sobreviveriam a uma indisponibilidade curta; alto demais atrasa a ida à DLQ de mensagens permanentemente inválidas.
- **`VisibilityTimeout=30s`:** default da fila. O consumidor pede 60s em cada `ReceiveMessage` (§18) e não estende a visibilidade durante o processamento.
- Criação via script de init (`docker/localstack/init/ready.d/01-create-queues.sh`) que valida nomes e `maxReceiveCount` antes de usá-los. É idempotente para os mesmos atributos; com atributos diferentes numa fila existente, a criação falha (o compose atual não persiste o estado do LocalStack, então isso não ocorre hoje).

## 6. Health checks (Fase 0)

Abertos, sem autenticação (CHALLENGE §2).

**`GET /health/live`** — sempre `200 {"status":"alive"}` enquanto o processo responde. **Não** consulta dependências: uma queda do Postgres não deve fazer o orquestrador reiniciar todas as instâncias (o que só pioraria a recuperação).

**`GET /health/ready`** — executa em paralelo os `ReadinessCheck` registrados, cada um com timeout próprio (`HEALTH_CHECK_TIMEOUT_MS`, 2s):

| Check (chave pública) | O que faz |
|---|---|
| `postgres` | `select 1` com timeout e cancelamento no servidor (a conexão volta ao pool) |
| `sqs` | `GetQueueUrl` da fila principal e da DLQ, com `abortSignal` |

Contrato da resposta:

```json
// 200
{ "status": "ready", "dependencies": { "postgres": { "status": "up" }, "sqs": { "status": "up" } } }

// 503
{ "status": "not_ready", "dependencies": { "postgres": { "status": "down", "reason": "unreachable" }, "sqs": { "status": "up" } } }
```

- `reason` é um **conjunto fechado**: `timeout` (não respondeu no prazo), `unreachable` (falha de rede/conexão), `error` (qualquer outro erro, ex.: fila inexistente).
- A resposta **nunca** carrega mensagem de driver, host, porta ou stack. O detalhe (nome e código do erro, sem payload) vai para o log do servidor.
- As chaves `postgres` e `sqs` vêm de `ReadinessCheck.name` e são contrato público: renomear um check é mudança de contrato.
- **Por que uma porta própria** (`ReadinessCheck` + `ReadinessService`) em vez de `@nestjs/terminus`: dois checks não justificam a dependência, e a lógica (timeout, classificação) fica testável sem framework. Novos checks (ex.: outbox lag) entram como mais um adaptador.
  - *Trade-off:* mantemos ~80 linhas que o terminus daria prontas.
- **503** é o código para "falha transitória de infraestrutura" e deve ser o mesmo nos demais endpoints (CHALLENGE §9).

## 7. Representação do `Money` (Fase 1)

**Escolha:** `bigint` em **centavos**, escala fixa de 2, dentro de uma classe imutável (`Object.freeze`) com construtor privado.

**Motivo:** é exato, nativo do runtime e sem dependência. Como a escala é fixa e o domínio só soma, subtrai e compara (não há divisão, juros nem câmbio), uma lib decimal de precisão arbitrária não traria ganho. Em nenhum ponto o valor passa por `number`: a string é validada por regex e convertida direto para `bigint`.
- *Trade-off:* se um dia houver divisão ou moeda com outra escala (ex.: JPY com 0 casas, BHD com 3), a escala por moeda e o arredondamento terão de ser introduzidos explicitamente. Hoje, assumir 2 casas é uma decisão consciente, e o modelo continua multi-moeda: `currency` faz parte do valor.

**Contrato de entrada** (`Money.from({ amount, currency })`):
- `amount` precisa ser uma **string** que case com `^(0|[1-9]\d{0,17})(\.\d{1,2})?$`. Isso rejeita: string vazia, espaços, `NaN`, `Infinity`, notação científica, sinal (`-` ou `+`), mais de 2 casas, vírgula, zeros à esquerda e **mais de 18 dígitos inteiros** (limite do `numeric(20,2)`). Também rejeita `number` em runtime.
- `"25"` e `"25.5"` **são aceitos** na entrada e **sempre serializados com 2 casas** (`"25.00"`, `"25.50"`). O `toJSON()` devolve `MoneyProps` (`{ amount: "25.00", currency: "BRL" }`), que é o formato de todos os contratos e eventos.
- `currency` precisa ser um código ISO-4217 de 3 letras maiúsculas.

**Operações:** `add`, `subtract` e `isLessThan` entre moedas diferentes lançam `CurrencyMismatchError`. `equals` entre moedas diferentes devolve `false`. `subtract`/`negate` podem gerar valor negativo (usado em comparações e na aritmética do ledger), mas nenhuma *entrada* é negativa. Um resultado além de ±18 dígitos inteiros lança `InvalidMoneyError`, para que o domínio nunca produza algo que o `numeric(20,2)` não aceite.

**Modelagem geral do domínio:** construtor privado e factories (`create`/`open`/`receive`/`enqueue` validam; `rehydrate` só reconstrói). Ids e datas são **injetados** pelo chamador: o domínio não gera UUID nem lê relógio, o que mantém tudo determinístico nos testes.

## 8. Máquina de estados da `WagerTransaction` (Fase 1)

```
              ┌──────────────────────┐
              │                      ▼
PENDING ──► PENDING_REFERENCE ──► PENDING_REFERENCE (nova tentativa, backoff)
   │              │
   ├──────────────┴──► PROCESSED   (terminal)
   ├──────────────┴──► REJECTED    (terminal, com failureCode)
   └──────────────┴──► FAILED      (terminal, com failureCode)
```

- `create` nasce em `PENDING`. Ela rejeita `OPENING` (interno, criado só pela abertura de wallet), exige `referenceExternalTransactionId` não vazio em `REFUND`/`ROLLBACK`, exige valor > 0 nos kinds que movem saldo e aceita valor ≥ 0 em `LOSS`.
- `markPendingReference(now)` serve à entrada (vindo de `PENDING`) e às novas tentativas (`PENDING_REFERENCE → PENDING_REFERENCE`). Cada chamada incrementa `referenceAttempts` e agenda `nextReferenceCheckAt = now + min(5s · 2^(n−1), 10min)`, limitado ao `deadline` opcional (o prazo da referência, §20). Só aceita transação que tenha referência.
- `markProcessed(referenceTransactionId, at, observedBalance)` exige o id interno da referência em `REFUND`/`ROLLBACK` e o saldo observado (na moeda da transação); `reject(code, observedBalance?)` aceita o saldo opcional. Ver §10.
- Qualquer transição a partir de `PROCESSED`, `REJECTED` ou `FAILED` lança `InvalidTransactionStateError`, porque é erro de programação e não caminho de negócio. `rehydrate` não revalida nada.
- **Direção no ledger** (`ledgerDirectionFor`): `BET` → DEBIT; `WIN`, `REFUND` e `OPENING` → CREDIT; `LOSS` não tem direção (não gera lançamento); `ROLLBACK` inverte a direção da referência, que precisa ser `BET`, `WIN` ou `REFUND`.
- `matchesPayload(hash)` distingue *replay* (mesmo hash) de *conflito* (mesma key, payload diferente).

**Wallet:** `open` devolve a wallet com `version = 1` e o lançamento CREDIT da transação OPENING (saldo inicial zero não gera lançamento). Cada `debit`/`credit` cria o lançamento **antes** de mutar o estado (se o lançamento for inválido, a wallet não muda), devolve o `WalletLedgerEntry` e incrementa `version` em 1. `WalletLedgerEntry.create` verifica valor > 0, mesma moeda, saldos ≥ 0 e `balanceBefore ± money = balanceAfter`.

**Outbox:** `scheduleRetry` usa `min(1s · 2^(attempts−1), 5min)`. O backoff é determinístico, sem jitter: o espalhamento entre instâncias vem do `SKIP LOCKED` da Fase 6. O id da mensagem é o `eventId`, para que publicações duplicadas sejam deduplicáveis pelo consumidor.

## 9. Taxonomia de `FailureCode` (Fase 1)

Strings estáveis (contrato público: só se acrescenta; renomear é breaking change, e o teste `failure-code.test.ts` quebra). A coluna "Ação do provedor" diz o que fazer ao recebê-las.

| Código | Quando | Ação do provedor |
|---|---|---|
| `INSUFFICIENT_BALANCE` | `BET` maior que o saldo | desistir (ou reenviar com outro valor, como nova transação) |
| `REVERSAL_WOULD_OVERDRAW` | `REFUND`/`ROLLBACK` deixaria o saldo negativo (ex.: rollback de um WIN já gasto) | tratamento operacional/manual |
| `WALLET_NOT_FOUND` | `walletId` inexistente | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | a wallet não pertence ao `playerId` informado | corrigir o payload |
| `CURRENCY_MISMATCH` | moeda da transação ≠ moeda da wallet ou da referência | corrigir o payload |
| `REFERENCE_NOT_FOUND` | prazo de `PENDING_REFERENCE` esgotado (1h a partir do `createdAt`, §20) sem a referência resolvida: ausente **ou** ainda pendente | reenviar a referência e depois a reversão, como nova transação |
| `REFERENCE_NOT_PROCESSED` | referência terminou `REJECTED` ou `FAILED` (se está `PENDING`/`PENDING_REFERENCE`, a reversão **aguarda**, não é rejeitada) | desistir: não há o que reverter |
| `INVALID_REFERENCE_KIND` | `REFUND`, `WIN` ou `LOSS` que não referencia `BET`, ou `ROLLBACK` que não referencia `BET`/`WIN`/`REFUND` | corrigir o payload |
| `REFERENCE_ALREADY_REVERSED` | a referência já tem um `REFUND` ou `ROLLBACK` `PROCESSED` (uma reversão no total, §15); vale também para `WIN`/`LOSS` sobre `BET` estornada | desistir (já aplicado) |
| `AMOUNT_MISMATCH` | valor da reversão ≠ valor da referência (não há reversão parcial) | corrigir o payload |
| `REFERENCE_ROUND_MISMATCH` | referência de outra rodada | corrigir o payload |
| `REFERENCE_PLAYER_MISMATCH` | referência de outro player | corrigir o payload |
| `REFERENCE_WALLET_MISMATCH` | referência de outra wallet | corrigir o payload |
| `INFRASTRUCTURE_FAILURE` | erro permanente de infraestrutura (status `FAILED`, auditável). Fase 7: pendente encerrada pelo worker após 5 erros inesperados seguidos (§20) | reenviar mais tarde com nova transação |
| `BALANCE_LIMIT_EXCEEDED` | crédito que levaria o saldo além do limite do `numeric(20,2)` (18 dígitos inteiros) — Fase 3 | tratamento operacional/manual |

- Não existe código de "referência de outro provider": a referência é resolvida por `(providerId, referenceExternalTransactionId)`, então outro provider resulta em `REFERENCE_NOT_FOUND`.
- A mesma idempotency key com payload diferente **não** é `failureCode`: é um conflito de requisição (HTTP 409, Fase 4) e não cria transação.
- Ordem de avaliação no use case (a primeira que falhar define o código): `WALLET_NOT_FOUND` → `WALLET_PLAYER_MISMATCH` → `CURRENCY_MISMATCH` → (se houver referência) ausente/pendente ⇒ `PENDING_REFERENCE` → `INVALID_REFERENCE_KIND` → `REFERENCE_WALLET_MISMATCH` → `REFERENCE_PLAYER_MISMATCH` → `REFERENCE_ROUND_MISMATCH` → `CURRENCY_MISMATCH` → `REFERENCE_NOT_PROCESSED` → `AMOUNT_MISMATCH` (só reversões) → `REFERENCE_ALREADY_REVERSED` → `INSUFFICIENT_BALANCE` / `REVERSAL_WOULD_OVERDRAW` / `BALANCE_LIMIT_EXCEEDED`.
- Rejeições no nível da wallet (`WALLET_*`, `CURRENCY_MISMATCH` da wallet) **não** devolvem saldo: a wallet pode ser de outro jogador. As demais devolvem o saldo observado.
- Os erros de domínio (`InsufficientBalanceError`, `CurrencyMismatchError`…) não carregam `failureCode`, porque o mesmo erro pode significar códigos diferentes (um débito sem saldo é `INSUFFICIENT_BALANCE` numa BET e `REVERSAL_WOULD_OVERDRAW` num ROLLBACK de WIN). O use case da Fase 3 faz o mapeamento.

## 10. Persistência e mapeamento (Fase 2)

**ORM:** MikroORM 6 (motivo na §2). Para esta fase pesam duas coisas: o `EntitySchema` permite mapear sem decorators, e `em.transactional()` com o Unit of Work grava saldo, ledger, inbox e outbox no mesmo flush/commit.

**Estratégia: registros de persistência + mappers.** Cada tabela tem uma classe de registro simples (`WalletRecord`, `WagerTransactionRecord`, `LedgerEntryRecord`, `InboxMessageRecord`, `OutboxMessageRecord`), mapeada por `EntitySchema`, e um par de funções `toXRecord(domínio)` / `toX(registro)`. A volta sempre passa pelo `rehydrate` do domínio. Arquivos: `src/infrastructure/persistence/*.persistence.ts`.
- *Por que não mapear as classes de domínio direto:* o MikroORM hidrataria campos privados (`_balance`, `_status`) sem passar pelo `rehydrate`, e o `Money` exigiria embeddable/custom type acoplado ao ORM.
- *Trade-off:* cópia campo a campo em cada direção, e o UoW não rastreia mudanças no objeto de domínio. Os repositórios da Fase 3 aplicam o estado do domínio no registro gerenciado. Aceito em troca de um domínio sem ORM e de reidratação explícita.
- Os registros não têm relações ORM (FKs são colunas `string`). Isso funciona porque **todas as FKs entre tabelas são `DEFERRABLE INITIALLY DEFERRED`**: são checadas no COMMIT, então a ordem de INSERT que o flush escolher não importa (há teste persistindo os lançamentos antes da transação e da wallet).
  - *Trade-off:* a violação de FK só aparece no commit, não no statement. Para o use case dá no mesmo: a transação inteira falha.
- Colunas geradas pelo banco e não mapeadas: `wallet_ledger_entries.seq` (cursor do ledger, lido pela consulta paginada da Fase 4) e `wager_transactions.wallet_fk_currency` (ver abaixo).

**Mapeamento do `Money`:** cada valor é uma coluna `numeric(20,2)`, e a moeda fica na coluna `currency char(3)` da linha (`wallets`, `wager_transactions`, `wallet_ledger_entries`). O MikroORM mapeia com `type: 'decimal', runtimeType: 'string'`, e o driver `pg` já entrega `numeric` como string, então o valor nunca passa por `number`: `Money.from({ amount: <string do banco>, currency })`. Na ida grava-se `money.amount` (string com 2 casas). O limite do `Money` (18 dígitos inteiros) é o mesmo do `numeric(20,2)`, e o round-trip de `"0.10"` e `"99999999999999.99"` é testado em `test/integration/persistence/round-trip.test.ts`.

**Saldo observado (`observed_balance`):** o replay devolve o saldo daquele momento (CHALLENGE §7.7), mas `LOSS` e as rejeições não têm lançamento de onde tirá-lo. Por isso `WagerTransaction` ganhou `observedBalance`, na moeda da transação: obrigatório em `markProcessed` (CHECK para `PROCESSED` no banco) e opcional em `reject`. Fica ausente quando não há wallet na moeda da transação (`WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`).

**Rejeições que o schema precisa aceitar:**
- `REJECTED`/`FAILED` ficam isentas da FK `(wallet_id, currency) → wallets`: a coluna gerada `wallet_fk_currency` é `NULL` nesses status e, com MATCH SIMPLE, a FK não é checada. Sem isso, `WALLET_NOT_FOUND` e `CURRENCY_MISMATCH` não poderiam ser gravadas, e precisam ser, para auditoria e replay. Nos outros status a FK vale integralmente.
- Em rejeições `REFERENCE_*_MISMATCH` grava-se **só** `reference_external_transaction_id`, e `reference_transaction_id` fica `NULL`: a FK composta `(reference_transaction_id, wallet_id)` impediria o insert de uma referência de outra wallet. O id interno só é obrigatório (CHECK) em `REFUND`/`ROLLBACK` `PROCESSED`.

**Códigos de erro do banco:** CHECK `23514`, UNIQUE `23505`, FK `23503`, triggers de imutabilidade `23001` (`restrict_violation`), divergência saldo × ledger `23514`. A Fase 3 traduz `23505` nas constraints de idempotência em replay/conflito.

**TRUNCATE não é bloqueado:** triggers de linha não disparam em TRUNCATE, que é operação administrativa (os testes limpam com ele). Em produção, o usuário da aplicação não deve ter permissão de `TRUNCATE`.

## 11. Garantia → constraint/trigger (Fase 2)

Todas criadas em `Migration20261107100000_schema` e provadas uma a uma em `test/integration/persistence/schema-constraints.test.ts`. Duplicam de propósito as verificações do domínio. A Fase 3 alterou três itens em migrations novas (a da Fase 2 não foi editada): `…200000_one_reversal_per_reference`, `…300000_idempotency_per_provider` e `…310000_balance_limit_failure_code` (novo valor no CHECK de `failure_code`). O `down` de cada uma restaura o estado anterior (testado em `migrations.test.ts`).

| Garantia | Onde o banco aplica |
|---|---|
| Uma wallet por `(player_id, currency)` | `uq_wallets_player_currency` |
| Saldo nunca negativo | `ck_wallets_balance_non_negative`, `ck_ledger_balance_before`, `ck_ledger_balance_after`, `ck_wager_tx_observed_balance` |
| `version >= 1` | `ck_wallets_version` |
| Moeda ISO de 3 letras | `ck_wallets_currency`, `ck_wager_tx_currency` (e as FKs de moeda) |
| Toda mudança de saldo tem lançamento, e vice-versa | constraint triggers deferidos `trg_wallets_balance_matches_ledger` e `trg_ledger_balance_matches_wallet`: no COMMIT, `wallets.balance` = `balance_after` do último lançamento (por `seq`), ou 0 sem lançamentos |
| Idempotência por key, escopada por provider (Fase 3) | `uq_wager_tx_provider_idempotency_key (provider_id, idempotency_key)` |
| Uma transação por `(provider_id, external_transaction_id)` | `uq_wager_tx_provider_external` |
| `kind`, `status`, `failure_code` nos valores do domínio | `ck_wager_tx_kind`, `ck_wager_tx_status`, `ck_wager_tx_failure_code` |
| Valor ≥ 0, e > 0 nos kinds que movem saldo | `ck_wager_tx_amount` |
| `REFUND`/`ROLLBACK` exigem referência externa | `ck_wager_tx_reference_required` |
| `PROCESSED` ⇔ `processed_at`; `PROCESSED` exige saldo observado; reversão `PROCESSED` exige referência interna | `ck_wager_tx_processed`, `ck_wager_tx_processed_balance`, `ck_wager_tx_processed_reference` |
| `REJECTED`/`FAILED` ⇔ `failure_code` | `ck_wager_tx_failure` |
| `PENDING_REFERENCE` tem referência e agendamento | `ck_wager_tx_pending_reference` |
| Moeda da transação = moeda da wallet (exceto rejeitadas/falhas) | `fk_wager_tx_wallet_currency` sobre a coluna gerada `wallet_fk_currency` |
| Referência interna existe e é da mesma wallet | `fk_wager_tx_reference` → `uq_wager_tx_id_wallet` |
| Uma reversão `PROCESSED` por referência, no total (Fase 3, §15) | índice único parcial `ux_wager_tx_one_reversal (reference_transaction_id) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| Transação terminal não muda; identidade/payload (e `correlation_id`, Fase 7) nunca mudam; transação nunca é apagada | trigger `trg_wager_transactions_guard` (BEFORE UPDATE OR DELETE) |
| Ledger append-only | trigger `trg_ledger_append_only` (BEFORE UPDATE OR DELETE) |
| Aritmética do lançamento | `ck_ledger_arithmetic`, `ck_ledger_amount_positive`, `ck_ledger_direction` |
| No máximo um lançamento por transação e wallet | `uq_ledger_wallet_transaction` |
| Moeda do lançamento = moeda da wallet | `fk_ledger_wallet_currency` → `uq_wallets_id_currency` |
| Lançamento pertence a uma transação da mesma wallet | `fk_ledger_transaction` → `uq_wager_tx_id_wallet` |
| Cursor estável do ledger | `seq bigint generated always as identity` + `uq_ledger_wallet_seq` |
| Inbox única por consumidor e mensagem | `pk_inbox_messages (consumer_name, message_id)` |
| Outbox: tentativas ≥ 0 | `ck_outbox_attempts` |

Índices para os workers: `ix_wager_tx_reference_check_due (next_reference_check_at) WHERE status='PENDING_REFERENCE'` (Fase 7), `ix_wager_tx_awaiting_reference (provider_id, reference_external_transaction_id) WHERE status='PENDING_REFERENCE'` (destravar pendentes quando a referência chega) e `ix_outbox_pending (next_attempt_at) WHERE published_at IS NULL`. A Fase 6 acrescentou `seq` (identity, `uq_outbox_seq`) e `ix_outbox_pending_aggregate (aggregate_id, seq) WHERE published_at IS NULL`, em `…400000_outbox_seq` (§19).

**Limitações conhecidas:**
- Saldo × ledger compara com o **último** lançamento, não com a soma de todos (a soma completa é a reconciliação da Fase 4). O encadeamento `balance_before` = `balance_after` do lançamento anterior não é verificado pelo banco; quem o garante é o domínio (`Wallet.apply`) mais o lock por wallet da Fase 3.
- O banco não verifica que só transação `PROCESSED` tenha lançamento, nem que o valor do lançamento seja igual ao da transação. Quem garante isso é o use case da Fase 3 (e o helper `expectLedgerConsistent` verifica nos testes).

## 12. Concorrência: lock pessimista por wallet (Fase 3)

**Escolha:** `SELECT ... FOR UPDATE` na linha da wallet, dentro da transação do use case (`MikroOrmWagerUnitOfWork`), com `SET LOCAL lock_timeout = '2000ms'`. O `UPDATE` da wallet ainda confere a `version` como segunda barreira.

**Por que pessimista, e não otimista com retry:**
- O caso dominante é contenção na **mesma** wallet: rodadas rápidas, reentregas at-least-once, várias instâncias. Com lock otimista, cada conflito vira rollback e reexecução inteira. Com pessimista, a segunda transação espera alguns milissegundos e roda sobre o estado já commitado.
- A checagem de idempotência fica **sob o lock**. A transação original, se existir, foi gravada por quem segurava o mesmo lock e já está visível (READ COMMITTED lê a cada statement). Assim "a mesma BET 50x em paralelo" vira 1 processamento + 49 replays, sem depender de violação de unicidade.
- *Trade-off:* uma conexão fica ocupada esperando o lock. Por isso o `lock_timeout` curto: esgotado, a transação aborta (SQLSTATE `55P03`) e o resultado é `TransientFailure('lock_timeout')`. O provedor reenvia a mesma requisição, que é idempotente.

**Granularidade:** só a linha da wallet é travada; wallets diferentes não se bloqueiam. Não há lock global, advisory lock nem tabela de controle. O lock usa `WHERE id = $wallet AND player_id = $player`: quem não é dono da wallet não segura nem espera o lock dela. Uma leitura sem lock distingue `WALLET_NOT_FOUND` de `WALLET_PLAYER_MISMATCH`.

**Segunda barreira (version):** `UPDATE wallets SET balance, version = v+1, updated_at WHERE id = $w AND version = $v`. Com o `FOR UPDATE` ela nunca deveria falhar. Se falhar (bug, ou escrita fora do use case), a transação faz rollback e o resultado é `TransientFailure('version_conflict')`, com log estruturado `wallet_lock_conflict` e contador. Lock timeout e deadlock também são contados. O contador fica em memória, por processo, e é provisório: as métricas exportáveis entram na Fase 8.

**Ausência de deadlock:** cada transação trava **uma única** linha de wallet, sempre antes de qualquer escrita, então não existe espera circular entre locks de linha. As outras esperas possíveis são de índices únicos (duas transações inserindo a mesma key em wallets diferentes). Como todas inserem nos mesmos índices e na mesma ordem, a espera é sempre num sentido só. Se ainda assim o Postgres detectar deadlock (`40P01`) ou falha de serialização (`40001`), o resultado é `TransientFailure`. Pool esgotado ou banco fora dão `TransientFailure('unavailable')`.

**SQL dentro da transação (READ COMMITTED):**
1. `BEGIN; SET LOCAL lock_timeout = '2000ms'`
2. `SELECT * FROM wallets WHERE id = $w AND player_id = $p FOR UPDATE`
3. `SELECT * FROM wager_transactions WHERE provider_id = $p AND (idempotency_key = $k OR external_transaction_id = $e)`. Se achar, é replay ou conflito e termina aqui (no replay só a inbox é gravada).
4. Se a wallet não veio: `SELECT count(*) FROM wallets WHERE id = $w` (sem lock).
5. Se há referência: `SELECT * FROM wager_transactions WHERE provider_id = $p AND external_transaction_id = $ref`, e depois `SELECT count(*) … WHERE reference_transaction_id = $id AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`.
6. `INSERT wager_transactions`, já no status final (PROCESSED, REJECTED ou PENDING_REFERENCE).
7. Se o saldo mudou: `UPDATE wallets … WHERE id = $w AND version = $v` e `INSERT wallet_ledger_entries`.
8. `INSERT outbox_messages` (1 ou 2 eventos) e, com contexto de inbox, `INSERT inbox_messages`.
9. `COMMIT`. As FKs deferidas e o trigger saldo × ledger são checados aqui.

**Comprovação:** `test/concurrency/process-wager-transaction.test.ts` usa 3 instâncias de MikroORM (pools separados) com `Promise.all`:
- 80+80 sobre saldo 100: uma PROCESSED, uma `INSUFFICIENT_BALANCE`, saldo 20, um débito;
- a mesma BET 50x: 1 débito, 1 linha, 49 replays;
- 30 BETs disputando o saldo;
- a mesma key em wallets diferentes.

Falhas transitórias são reenviadas idênticas, com backoff curto, como faria um provedor. O caminho `23505 → conflito` também tem um teste determinístico, em que uma transação externa segura o INSERT.

## 13. Fluxo de idempotência (Fase 3)

A garantia é o banco, nunca memória.

1. **Antes da transação:** validação completa (`InvalidInput` não grava nada) e cálculo do `payloadHash` (§14).
2. **Sob o lock da wallet:** busca por `(provider_id, idempotency_key)` **ou** `(provider_id, external_transaction_id)`.
   - Mesma key **e** mesmo hash → **replay**. O resultado é reconstruído do estado persistido (`status`, `failure_code`, `observed_balance`) e é idêntico ao original, exceto por `idempotentReplay: true`. Vale para PROCESSED, REJECTED e PENDING_REFERENCE. Esta última devolve o estado atual, que pode já ter sido resolvido pelo worker da Fase 7.
   - Hash diferente, ou o mesmo `externalTransactionId` sob outra key → **conflito** (`IdempotencyConflict` com o id existente). Nada é gravado.
3. **Se o INSERT violar a unicidade mesmo assim** (por exemplo, a mesma key com outra `walletId`, que trava outra linha, ou a mesma mensagem SQS reentregue):
   - o adaptador só traduz `23505` nas constraints esperadas: `uq_wager_tx_provider_idempotency_key` e `uq_wager_tx_provider_external` viram `idempotency`, e `pk_inbox_messages` vira `inbox`;
   - depois do rollback, o use case relê numa transação nova e devolve replay ou conflito;
   - uma mensagem de inbox já usada por **outra** transação devolve `IdempotencyConflict` sem id, e não deve ser reenviada;
   - `23505` em qualquer outra constraint, ou de idempotência sem linha correspondente, é bug e é relançado.

**Escopo por provider:** a idempotency key é única por `(provider_id, idempotency_key)`. Com unicidade global, um provider poderia gravar antes a key de outro e bloquear a transação legítima dele, recebendo ainda o id interno dela no conflito. A borda (Fase 4/5) precisa garantir que `payload.providerId` é o provider autenticado.

**Resultado do use case:** é uma união tipada; o mapeamento para HTTP/SQS é da Fase 4/5.

| Variante | Significado |
|---|---|
| `Processed` | aplicada; traz `status` e saldo |
| `PendingReference` | aguardando a referência; traz `status` |
| `Rejected` | `status` REJECTED = regra de negócio; FAILED = falha permanente de infra |
| `IdempotencyConflict` | mesma key com outro payload, ou mensagem de inbox já usada |
| `InvalidInput` | motivo em texto; códigos por campo ficam para a Fase 4 |
| `TransientFailure` | `lock_timeout`, `deadlock`, `serialization`, `unavailable` ou `version_conflict`; sempre seguro reenviar a mesma requisição |

Erros lançados fora da união são bugs (500 / sem ack).

**Eventos** gravados na outbox na mesma transação: `WagerTransactionProcessed` (inclusive LOSS), `WalletBalanceChanged` (somente com lançamento), `WagerTransactionRejected` e `WagerTransactionPendingReference`.
- `correlationId` vem da entrada.
- `causationId` é o que originou o evento. Nos eventos de transação, é o `messageId` da inbox (SQS) ou a idempotency key (HTTP). No `WalletBalanceChanged`, é o `eventId` do `WagerTransactionProcessed` que o causou.

## 14. Algoritmo do `payloadHash` (Fase 3)

`payloadHash = hex(SHA-256(utf8(JSON canônico)))`, em `src/application/wagering/payload-hash.ts`.

- **Campos (só de negócio):** `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money: { amount, currency }` e `referenceExternalTransactionId`. Ficam fora o header (`Idempotency-Key`), o `correlationId` e os metadados de transporte.
- **Normalização:**
  - `money.amount` passa pelo `Money` e sai sempre com 2 casas, então `"25"` e `"25.00"` são o mesmo payload;
  - `walletId` vai em minúsculas (é UUID);
  - referência ausente entra como `null`.
- **Canônico:** chaves ordenadas por code unit, recursivamente, sem espaços, com strings escapadas como no `JSON.stringify`.

Exemplo do JSON hasheado:

```json
{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a","referenceExternalTransactionId":null,"roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}
```

Mudar campos, normalização ou ordenação muda os hashes já gravados e transforma replays legítimos em conflitos. É mudança de contrato, e o teste `payload-hash.test.ts` fixa o JSON exato.

## 15. Interpretação das referências e reversões (Fase 3)

O CHALLENGE §7.4 diz que "uma referência não pode ser revertida duas vezes **pelo mesmo tipo** de operação". Adotamos uma regra mais estrita, para nunca creditar duas vezes:

- **Uma reversão no total por transação:** uma BET recebe no máximo um `REFUND` **ou** um `ROLLBACK` PROCESSED, não os dois. Sem isso, BET 10 → REFUND +10 → ROLLBACK da BET +10 devolveria a aposta duas vezes. O índice `ux_wager_tx_one_reversal` (migration `…200000`) garante isso no banco; o use case checa antes, sob o lock, e rejeita com `REFERENCE_ALREADY_REVERSED`.
- **ROLLBACK de REFUND** continua permitido e reverte o estorno, debitando. Ele referencia o REFUND, não a BET, então não conta como segunda reversão da BET.
- **WIN/LOSS sobre BET já estornada** → `REFERENCE_ALREADY_REVERSED`. Liquidar uma aposta cujo valor já voltou ao jogador pagaria prêmio sobre uma aposta que não existe mais.
- **WIN e LOSS podem referenciar a BET** da rodada (é opcional). Quando referenciam, valem as mesmas validações da reversão, exceto valor igual: kind = BET, mesma wallet, player, rodada e moeda, status PROCESSED. Referência inexistente ou ainda pendente → `PENDING_REFERENCE`.
- **Valor:** reversões exigem valor igual ao da referência (`AMOUNT_MISMATCH`). Não há reversão parcial.
- **Auto-referência:** uma transação não referencia a si mesma (`InvalidInput`), e BET não referencia nada.
- **Saldo insuficiente na reversão** (por exemplo, ROLLBACK de um WIN já gasto) → `REVERSAL_WOULD_OVERDRAW`. É distinto do `INSUFFICIENT_BALANCE` da BET e fica auditável.
- **Crédito além do limite do `numeric(20,2)`** → `BALANCE_LIMIT_EXCEEDED`, com a wallet intacta.

**Limitação conhecida:** um `REFUND` de uma BET que já tem `WIN` PROCESSED é aceito. A spec não proíbe, e o provedor pode estornar uma rodada cancelada depois de liquidada. O jogador fica com o prêmio e com o valor da aposta. Barrar isso exige definir a prioridade entre liquidação e estorno, o que é decisão de negócio.

## 16. API HTTP (Fase 4)

### Mapeamento de status

O provedor decide se reenvia só pelo status, sem ler mensagem. O mapeamento vale para todos os endpoints:

| Situação | Status | Corpo | Reenviar? |
|---|---|---|---|
| `Processed` | 200 | `{ transactionId, status, balance, idempotentReplay }` | — |
| Wallet aberta (`POST /wallets`) | 201 | `{ id, playerId, balance, version: 1 }` | — |
| `PendingReference` | 202 | `{ transactionId, status, nextReferenceCheckAt, idempotentReplay }` | consultar depois |
| Payload, header ou parâmetro inválido (`InvalidInput`), JSON malformado, id que não é UUID | 400 `INVALID_INPUT` | envelope | não; corrigir |
| Recurso ou rota inexistente | 404 `NOT_FOUND` | envelope | não |
| Mesma key (ou id externo) com outro payload | 409 `IDEMPOTENCY_CONFLICT` + `existingTransactionId` | envelope | não |
| Wallet duplicada (player + moeda) | 409 `WALLET_ALREADY_EXISTS` + `walletId` | envelope | não; usar o `walletId` |
| `Rejected` (REJECTED **e** FAILED) | 422 | `{ transactionId, status, failureCode, balance?, idempotentReplay }` | não; o replay devolve o mesmo 422 |
| Falha transitória (lock timeout, deadlock, version, banco fora) | 503 `TRANSIENT_FAILURE` + `Retry-After: 1` | envelope | sim, com a mesma key |
| Bug | 500 `INTERNAL_ERROR` | envelope | não |

- **Envelope de erro único:** `{ "error": { "code", "message", ...detalhes } }`, renderizado pelo `ApiExceptionFilter` global. Cobre também as exceções do Nest (JSON malformado, rota desconhecida) e os erros inesperados. `message` é texto fixo nosso: mensagens do Postgres nunca chegam ao cliente (o 500 só é logado, com nome e SQLSTATE).
- **503 é exclusivo de falha transitória.** `FAILED` é terminal: um 503 faria o provedor reenviar e receber o mesmo replay para sempre. Por isso vai como 422 com `status: "FAILED"`. Erros transitórios lançados fora dos use cases (nas consultas) são reconhecidos pelo mesmo `translatePersistenceError` e também viram 503.
- **422 não usa o envelope de erro:** é o resultado de uma transação gravada (tem `transactionId` e é replayável), com o mesmo formato do 200.
- **Replay** devolve o mesmo status do original e `idempotentReplay: true`. Uma `PendingReference` pode já ter se resolvido; nesse caso o replay devolve o estado atual (§13).
- `Idempotency-Key` ausente ou só com espaços → 400. A validação do corpo é a do use case (`parse`), que roda antes de abrir a transação: nada inválido é gravado.

### Abertura de wallet

- O use case `OpenWallet` (application) usa a mesma `WagerUnitOfWork`. Numa transação SQL, grava a wallet (version 1), a transação `OPENING` (factory `WagerTransaction.opening`, que já nasce PROCESSED), o lançamento CREDIT e o `WalletBalanceChanged` na outbox. A OPENING é interna e **não** gera `WagerTransactionProcessed`.
- Saldo inicial zero não gera OPENING, lançamento nem evento.
- A duplicata é detectada pela constraint `uq_wallets_player_currency`, traduzida como `UniqueViolationError('wallet')`. O 409 relê e devolve o `walletId` existente, para o cliente que perdeu a resposta do primeiro POST.
- `playerId` segue a regra de texto do use case (obrigatório, não vazio, até 256 caracteres).
- **Nomes reservados:** a OPENING usa `providerId = "internal"` e key/id externo `opening:<walletId>`. Providers externos não podem usar esse `providerId` nem keys com prefixo `opening:` (400), e `GET /providers/internal/...` também é 400. Sem isso, um cliente poderia ler as OPENINGs ou receber o id delas num 409.

### Consultas

- `GET /wallets/:id`, `GET /wagering/transactions/:id` e `GET /providers/:providerId/wagering/transactions/:externalId`: 404 quando não existe, 400 quando o id não é UUID. Campos ausentes saem como `null`, nunca omitidos.

### Cursor do ledger

- `GET /wallets/:id/ledger?cursor=&limit=` devolve os lançamentos em ordem crescente de `wallet_ledger_entries.seq` (identity). `limit` tem padrão 50 e teto 200; fora disso, 400.
- Cursor = base64url de `v1:<seq>` do último item da página. É opaco para o cliente, e o prefixo de versão permite trocar o formato sem quebrar cursores em circulação. Cursor vazio, malformado, fora da faixa de `bigint` ou repetido na query → 400.
- **Estável, sem pular nem repetir:** os lançamentos de uma wallet só são gravados sob o lock dela (§12), então `seq` cresce na ordem de commit dentro da wallet. Uma inserção nova sempre fica depois de qualquer cursor já emitido.
- `nextCursor` é `null` na última página: a consulta busca `limit + 1` para saber se há mais.

### Reconciliação

- `POST /wallets/:id/reconciliation` lê o saldo e a soma do ledger (CREDIT − DEBIT) **num único statement**, então os dois vêm do mesmo snapshot.
- `difference = storedBalance − calculatedBalance`. `consistent` é `difference == 0.00`, e `checkedEntries` é o número de lançamentos somados.
- **Nunca corrige.** Na divergência: log `warn` em JSON (`reconciliation_divergence`, com `walletId` e `correlationId`), incremento de `wagering_reconciliation_divergences_total` e `consistent: false` na resposta. Corrigir exige investigar a causa; um ajuste automático esconderia o bug que a gerou.
- Cobre o que o schema não garante (§11): problemas no encadeamento de `balance_before` ou no valor do lançamento aparecem como divergência de soma.

### Autenticação (CHALLENGE §2)

- **Decisão:** não implementada nesta fase, porque não vale pontos e competiria com a correção financeira. O ponto de extensão é o `AuthGuard` (no-op), aplicado ao `WageringController`. Health e `/metrics` ficam fora do guard.
- **Desenho que adotaríamos:** IdP externo (Keycloak) com OAuth2 *client credentials*, um client por provider. O `AuthGuard` valida o JWT (assinatura via JWKS, `iss`, `aud`, `exp`) e coloca na requisição o `providerId` da claim do client.
  - `POST /wagering/transactions`: `payload.providerId` diferente do token → 403. Hoje o use case confia no `providerId` do payload (ver pendência no PROGRESSO).
  - Consultas: `GET /providers/:providerId/...` só para o próprio provider; `GET /wagering/transactions/:id` filtrado pelo provider do token (404 para transação alheia).
  - `POST /wallets` e reconciliação: escopos administrativos próprios (`wallets:write`, `wallets:reconcile`), não o de provider.
  - O SQS continua como canal interno confiável (§2), mas com as mesmas validações de domínio.
- **Trade-off:** sem autenticação, qualquer cliente que alcance a API consegue submeter em nome de qualquer provider e ler transações e saldos. É aceitável só em ambiente de avaliação.

## 17. Observabilidade (Fase 8, parte independente de SQS/outbox)

### Logs

- JSON (pino), uma linha por evento, a partir de um logger raiz (`infrastructure/observability/logger.ts`). O logger do Nest (boot, erros do framework) usa o mesmo JSON, via `PinoNestLogger`.
- `correlationId`: lido de `X-Correlation-Id` quando casa com `^[A-Za-z0-9._:-]{1,128}$`; caso contrário, é gerado um UUID. É sempre devolvido no header da resposta, inclusive em erros que acontecem antes do middleware (como JSON malformado), e propagado até o `correlationId` dos eventos da outbox.
- Campos: `correlationId`, `providerId`, `walletId` e `transactionId` quando existem; `messageId` (e `sqsMessageId`) nas entradas por SQS (§18). O log de requisição usa o template da rota (`/wallets/:id`), não a URL.
- Nunca entram nos logs: payload financeiro completo, valores, mensagens do Postgres.

### Métricas

- `InstrumentedProcessWagerTransaction` envolve o **use case**, não o controller, para que HTTP e o consumidor SQS (Fase 5) passem pelas mesmas métricas. Erros lançados também são medidos (`status="ERROR"`) e depois relançados.
- Registry próprio (`new Registry()` por `ObservabilityMetrics`), nunca o default do prom-client: duas aplicações no mesmo processo (como nos testes) não colidem.
- Labels só de conjunto fechado: `status`, `kind` e `failure_code`. Um `kind` fora do enum vira `UNKNOWN`, porque o valor cru vem do cliente e explodiria a cardinalidade. Ids nunca são labels.

| Métrica | Tipo | Labels | Fase |
|---|---|---|---|
| `wagering_transactions_total` | counter | status, kind, failure_code | 8 |
| `wagering_processing_duration_seconds` | histogram | status, kind, failure_code | 8 |
| `wagering_idempotent_replays_total` | counter | kind | 8 |
| `wagering_idempotency_conflicts_total` | counter | kind | 8 |
| `wagering_lock_conflicts_total` | counter | — | 3/8 |
| `wagering_reconciliation_divergences_total` | counter | — | 4/8 |
| `wagering_retries_total` | counter | — | 5: cada `ChangeMessageVisibility` de retry no consumidor |
| `wagering_dlq_messages_total` | counter | — | 5: cada mensagem enviada à DLQ pelo consumidor (não conta o redrive nativo) |
| `wagering_outbox_lag_seconds` | gauge | — | 6: agora − `occurred_at` do pendente mais antigo (§19) |
| `wagering_outbox_published_total` | counter | — | 6: eventos publicados e commitados |
| `wagering_outbox_publish_failures_total` | counter | scope (`batch`, `entry`) | 6: chamada inteira falhou × entrada recusada |
| `wagering_outbox_retries_total` | counter | — | 6: eventos reagendados com backoff |
| `wagering_outbox_stuck_events` | gauge | — | 6: pendentes com `attempts >= OUTBOX_STUCK_ATTEMPTS` |
| `wagering_pending_references` | gauge | — | 7: transações em PENDING_REFERENCE, medido a cada `PENDING_REFERENCE_GAUGE_INTERVAL_MS` (§20) |
| `wagering_pending_reference_resolved_total` | counter | status (`PROCESSED`, `REJECTED`) | 7: resolvidas com a referência encontrada |
| `wagering_pending_reference_expired_total` | counter | — | 7: prazo esgotado → `REFERENCE_NOT_FOUND` |
| `wagering_pending_reference_rescheduled_total` | counter | — | 7: novas tentativas agendadas |
| `wagering_pending_reference_failed_total` | counter | — | 7: encerradas como FAILED após erros inesperados seguidos |
| `wagering_pending_reference_skipped_total` | counter | reason (`wallet_busy`, `not_due`, `transient`, `error`) | 7: candidatas puladas; `error` é o alerta de bug |

- `GET /metrics` é aberto, como os health checks. Em produção ficaria numa porta interna ou atrás da rede do scraper.
- **Limitação:** os contadores são por instância (o Prometheus soma). O contador em memória do `LoggingLockConflictTelemetry` fica só para os testes.

## 18. Consumidor SQS (Fase 5)

`src/interfaces/sqs/wager-consumer.ts`, ligado por `SQS_CONSUMER_ENABLED` (default `true`; `false` no `.env.test`). Cliente da fila em `src/infrastructure/sqs/`.

### Fluxo por mensagem

1. **Receive** com long polling: `WaitTimeSeconds=20`, `MaxNumberOfMessages=10`, `VisibilityTimeout=60`. Pede `ApproximateReceiveCount` e `MessageGroupId`.
2. **Envelope** (`wager-envelope.ts`): JSON, `messageId` (texto até 256), `type = WagerTransactionRequested`, `occurredAt` ISO 8601 com fuso, `data` objeto, `data.idempotencyKey` obrigatório. Usa o mesmo `textProblem` do use case. Os campos de negócio de `data` são validados pelo próprio use case, o mesmo validador da entrada HTTP. Por isso `kind=OPENING` e `providerId=internal` são `InvalidInput`.
3. **`payloadHash` da inbox:** SHA-256 hex do JSON canônico (§14) de `{ type, data }`. Ficam fora `messageId`, `occurredAt`, `correlationId` e outros metadados. É diferente do `payloadHash` da transação, que só cobre os campos de negócio normalizados: o da inbox identifica a **mensagem** (inclui a `idempotencyKey` e não normaliza `"25"` × `"25.00"`).
4. **Pré-checagem da inbox** `(consumerName, messageId)`, fora da transação. Se já existe: mesmo hash → ack sem chamar o use case (conta como replay); hash diferente → DLQ. É só o caminho rápido. A garantia é a PK da inbox, gravada **na mesma transação** do efeito.
5. **Use case** via `InstrumentedProcessWagerTransaction` (mesmas métricas do HTTP), com `inbox = { consumerName, messageId, payloadHash }` e `correlationId` = o do envelope, se válido (§17), senão o `messageId`.
6. **Ação** conforme a tabela abaixo. O ack (`DeleteMessage`) só acontece depois que o use case retorna, ou seja, depois do commit. Se o `DeleteMessage` falhar, a reentrega cai na pré-checagem da inbox e é confirmada sem efeito novo (testado).

### Classificação

| Resultado / erro | Ação |
|---|---|
| `Processed`, `Rejected` (REJECTED e FAILED), `PendingReference`, inclusive replay | ack |
| Inbox com a mesma mensagem e o mesmo hash (pré-checagem ou releitura) | ack, `wagering_idempotent_replays_total` |
| `IdempotencyConflict` com `existingTransactionId` e sem linha na inbox | ack + log `warn` (`wagering_idempotency_conflicts_total`, no wrapper) |
| `IdempotencyConflict` sem id (corrida na PK da inbox) | relê a inbox: mesmo hash → ack; outro hash → DLQ `INBOX_PAYLOAD_MISMATCH`; sem linha → retry |
| Inbox com o mesmo `messageId` e outro hash | DLQ `INBOX_PAYLOAD_MISMATCH` |
| Corpo não-JSON, envelope inválido ou ilegível | DLQ `INVALID_ENVELOPE` |
| `InvalidInput` | DLQ `INVALID_PAYLOAD` (motivo em `dlqDetail`) |
| `TransientFailure`, `TransientPersistenceError` da pré-checagem, exceção inesperada (bug) | retry: `ChangeMessageVisibility` com backoff + `wagering_retries_total`; na 5ª tentativa → DLQ `MAX_ATTEMPTS_EXCEEDED` |

- **DLQ:** primeiro `SendMessage` na `wager-transactions-dlq.fifo`, depois `DeleteMessage` na principal. Atributos: `dlqReason` (um dos 4 códigos acima), `dlqDetail` (até 256 caracteres, sem valores do payload), `sourceMessageId` e `receiveCount`. O `MessageGroupId` é o original. O `MessageDeduplicationId` é o MessageId do SQS: se o delete falhar, a reentrega reenvia para a DLQ e o broker deduplica (testado). Conta em `wagering_dlq_messages_total`.
- **Erro inesperado** é tratado como transitório até o limite: um bug não descarta a mensagem na primeira falha, e ela acaba na DLQ com motivo, para análise.

### Números

| Parâmetro | Valor | Motivo |
|---|---|---|
| Limite do consumidor (`SQS_CONSUMER_MAX_ATTEMPTS`) | 5 | DLQ com motivo e métrica, decidida pelo consumidor |
| `maxReceiveCount` da fila | 10 | rede de segurança; ver abaixo |
| Backoff do retry | `30s·2^(n−1)`, teto 300s: 30/60/120/240 | `n` = `ApproximateReceiveCount` |
| `VisibilityTimeout` no receive | 60s | pior caso de um lote: 10 mensagens do mesmo grupo em sequência × ~5s (`lock_timeout` 2s + releitura) |
| `WaitTimeSeconds` | 20 | long polling: menos chamadas vazias |
| Pausa do polling (banco/SQS fora) | `1s·2^(n−1)`, até 30s | não drenar a fila contra um banco fora do ar |
| `SQS_SHUTDOWN_TIMEOUT_MS` | 8s | um dos três prazos de shutdown que rodam em sequência; a soma cabe no orçamento de 25s, abaixo do `stop_grace_period` de 30s (§21, Fase 9; era 25s) |

**Tolerância a falha transitória:** uma mensagem tem 5 tentativas separadas por 30+60+120+240 = 450s. Isso dá **~7,5 min** desde o primeiro recebimento até a DLQ. Quando a falha é `unavailable` (banco fora, pool esgotado) ou o próprio SQS falha, o loop também pausa o polling (1s, 2s, 4s… até 30s, e zera no primeiro lote sem falha de conexão). Assim a instância não sai recebendo e queimando tentativas de mensagens novas enquanto o banco está fora. Mensagens já recebidas seguem o backoff normal. Depois da DLQ, a recuperação é o redrive manual da DLQ para a fila principal (é seguro: a inbox e a idempotência impedem efeito duplicado).

**Por que 5 no consumidor e 10 na fila:** o SQS incrementa o `ApproximateReceiveCount` a cada **recebimento**, mesmo quando a mensagem não é processada. As mensagens que esperam atrás de uma que falhou no mesmo grupo são recebidas de novo a cada ciclo, sem processar, e a contagem delas sobe junto (o mesmo vale para mensagens devolvidas no shutdown). Com redrive em 5, a fila mandaria essas mensagens válidas, nunca tentadas, para a DLQ sem motivo nem métrica. Com o limite em 5 no consumidor e 10 na fila:
- a mensagem que falha vai para a DLQ pelo consumidor, com motivo, na 5ª tentativa, e as seguintes do grupo são processadas em seguida, no mesmo lote (testado);
- o redrive nativo só age se o consumidor não conseguir decidir (por exemplo, falhas repetidas do próprio SQS).

**Efeito colateral aceito:** uma mensagem seguinte cuja contagem já subiu (por exemplo, 5) e que então falha de forma transitória vai direto para a DLQ com `MAX_ATTEMPTS_EXCEEDED`, sem as próprias 5 tentativas. Fica na DLQ com motivo e pode ser reprocessada por redrive manual. Contar tentativas reais exigiria estado por mensagem fora do SQS.

### FIFO é otimização, não garantia

- `MessageGroupId = walletId` e `MessageDeduplicationId = messageId` vêm do produtor. A dedup do broker só vale por 5 minutos e só para o mesmo dedup id. A ordem por grupo não protege contra reentrega, outro produtor, redrive manual ou várias instâncias. A correção vem do banco: inbox por `(consumerName, messageId)`, idempotência por `(provider_id, idempotency_key)` e lock por wallet (§12–13). O CHALLENGE §5.3 proíbe depender só do FIFO.
- Mesmo assim, o consumidor preserva a ordem do grupo, porque ela reduz `PENDING_REFERENCE` (ROLLBACK antes da BET):
  - grupos diferentes do lote rodam em paralelo; o mesmo grupo, em sequência;
  - se uma mensagem vai para retry, as seguintes do grupo recebem **a mesma visibilidade** e voltam junto, atrás dela. Não se depende de o broker bloquear o grupo enquanto há mensagem em voo: o LocalStack não bloqueia, e um teste com BET + ROLLBACK falhava ao liberar as seguintes com visibilidade 0;
  - se a própria ação no SQS falhar (`ChangeMessageVisibility`, envio à DLQ), o grupo para e as seguintes ficam em voo até expirar, junto com a que falhou.

### Shutdown (`SIGTERM`)

`WagerConsumerModule.beforeApplicationShutdown`, que roda antes de o ORM e o cliente SQS fecharem (`onApplicationShutdown`), executa:
1. para de buscar, acorda uma pausa em andamento e **aborta o `ReceiveMessage` em andamento** (`abortSignal` do SDK; Fase 9), para que o long polling de até 20s não consuma o prazo de 8s (§21);
2. espera o lote atual até `SQS_SHUTDOWN_TIMEOUT_MS`;
3. no timeout, `ChangeMessageVisibility 0` em tudo o que não terminou.

**Trade-off do abort:** cancelar no cliente não cancela o poll no servidor. Se uma mensagem chegar exatamente nesse intervalo, o SQS (e o LocalStack) pode entregá-la à conexão abortada, e ela fica em voo até a visibilidade expirar (60s) antes de voltar para outra instância. Não há perda nem efeito duplicado; o efeito é o mesmo de um processo que cai (testado). A alternativa seria esperar o poll terminar, o que exigiria `stop_grace_period` acima de 20s só para o consumidor.

O processamento abandonado pode ainda commitar. A outra instância que pegar a mensagem cai na inbox ou na idempotência, e o resultado é um único efeito (testado). Um `start()` não abre um segundo loop enquanto o anterior não terminou. Os testes usam `app.close()`, que dispara os mesmos hooks. O vínculo sinal → hooks vem de `enableShutdownHooks()` em `main.ts` e não tem teste automatizado.

### Logs

`sqs_message_acked`, `sqs_message_retry`, `sqs_message_dead_lettered`, `sqs_ack_failed`, `sqs_polling_paused`, entre outros. Todos com `sqsMessageId`, `receiveCount`, `messageId`, `correlationId` e, quando houver, `transactionId`, `outcome` ou `reason`. O log do use case também recebe o `messageId`. Nunca entram `data`, valores nem o `dlqDetail`.

`sqs_message_acked` só é emitido **depois** do `DeleteMessage` bem-sucedido (Fase 9; antes saía antes do delete). Se o delete falha, sai só `sqs_ack_failed` (com o `outcome`), e a reentrega aparece depois como `sqs_message_acked` com `DUPLICATE_MESSAGE` (testado). Contar acks pelo log, portanto, conta acks reais.

### Limitações

- **C4a (mensagem não registrada na inbox):** o use case só grava a inbox quando a mensagem é processada (inclusive replay). Se a primeira entrega de um `messageId` termina em `IdempotencyConflict` ou `InvalidInput`, nenhuma linha é gravada. Uma mensagem posterior com o **mesmo** `messageId` e outro payload válido não é reconhecida como divergente e é processada normalmente (com a própria idempotency key, sem duplicar efeito de nenhuma transação). Fechar isso exige gravar a inbox também nesses desfechos, o que muda o use case. Fica registrado.
- A corrida entre a pré-checagem e o commit é resolvida pela PK da inbox e pela releitura. A pré-checagem nunca é a garantia.
- O processamento de um lote não estende a visibilidade (não há heartbeat). Um lote acima de 60s pode ser reentregue em paralelo, o que é seguro, mas desperdiça trabalho.

## 19. Outbox publisher (Fase 6)

`src/interfaces/workers/outbox-publisher.ts`, ligado por `OUTBOX_PUBLISHER_ENABLED` (default `true`; `false` no `.env.test`). SQL em `src/infrastructure/outbox/outbox-store.ts` e envio em `outbox-events.client.ts`. O destino é `wager-events.fifo` (§5).

### Claim: `SKIP LOCKED`, publicando ainda com o lock

Cada ciclo é **uma transação curta**:

```sql
BEGIN;
SET LOCAL statement_timeout = '5000ms';
SET LOCAL idle_in_transaction_session_timeout = '15000ms';   -- OUTBOX_IDLE_IN_TRANSACTION_TIMEOUT_MS
select o.* from outbox_messages o
where o.published_at is null
  and (o.next_attempt_at is null or o.next_attempt_at <= $now)
  and not exists (select 1 from outbox_messages p
                  where p.aggregate_id = o.aggregate_id and p.published_at is null and p.seq < o.seq)
order by o.seq limit $batch            -- OUTBOX_BATCH_SIZE, até 10 (limite do SendMessageBatch)
for update of o skip locked;
-- SendMessageBatch, ainda com o lock
update outbox_messages set published_at = ?, attempts = ?, next_attempt_at = ?
  where id = ? and published_at is null;                     -- por evento
COMMIT;
```

- **Várias instâncias:** com `SKIP LOCKED`, cada publisher pega linhas diferentes, sem fila de espera e sem lock global. O Postgres aplica o `LIMIT` depois dos locks, então linhas puladas não ocupam vaga no lote.
- **Por que publicar com o lock, e não marcar "em andamento" e soltar:** não é preciso coluna de lease nem lógica de expiração. Se o processo morre, a conexão cai, o Postgres faz rollback e o lock some sozinho.
  - *Trade-off:* uma conexão do pool fica presa durante o envio. Por isso o lote é pequeno e a chamada tem prazo.
- **`$now` vem do `Clock` injetado**, não do `now()` do banco. Assim os testes avançam o tempo e conferem o backoff pelos valores gravados.
- **O `update` exige `published_at is null`** e confere `affectedRows = 1`. Sob o lock isso nunca falha; se falhar, é bug, e o lote inteiro sofre rollback (testado).

### Garantia at-least-once e contrato de dedup

- O evento só é marcado publicado **no mesmo commit** em que o envio foi aceito. Se o processo morre entre o envio e o commit, o evento continua pendente e é republicado por esta ou outra instância, **com o mesmo `eventId`**. Testado com exceção e com `pg_terminate_backend`.
- Nunca acontece o contrário: um evento marcado sem ter sido aceito pelo broker.
- **Contrato para quem consome `wager-events.fifo`:**
  - o corpo é exatamente o `toJSON()` gravado em `outbox_messages.payload` (CHALLENGE §11);
  - `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId`;
  - **o consumidor deve deduplicar por `eventId`, de forma persistente** (por exemplo, uma inbox como a da §18).
- A dedup do broker (5 min, mesmo dedup id) é só otimização: some numa republicação depois da janela ou num redrive.
- Não existe consumidor de `wager-events` neste sistema, então o lado do consumidor não tem teste aqui. O que está testado é a metade do publisher: a republicação reusa o `eventId`.

### Ordem por agregado

- `seq bigint generated always as identity` é atribuído no INSERT. Os eventos de uma wallet são inseridos **sob o lock da wallet** (§12), então, dentro de um agregado, ordem de `seq` = ordem de commit.
- **Regra:** só é elegível o pendente de **menor `seq`** do agregado (o `not exists` do claim, servido por `ix_outbox_pending_aggregate`).
  - Um evento anterior bloqueia os seguintes do agregado quando está travado por outro publisher, em backoff ou falhando.
  - Por isso dois publishers nunca publicam o mesmo agregado fora de ordem (testado com falha no 1º evento e dois publishers).
  - Uma leitura defasada do `not exists` só erra para o lado seguro: um evento publicado nunca volta a pendente, então o snapshot antigo só pode excluir um evento a mais, nunca liberá-lo cedo.
- **`aggregateId` dos eventos** (mantido como estava):
  - `WalletBalanceChanged` usa `wallet.id`. A **ordem do saldo** é garantida por ele, que ainda carrega `walletVersion`: o consumidor pode descartar versões menores ou iguais à última aplicada.
  - `WagerTransactionProcessed`/`Rejected`/`PendingReference` usam `tx.id`. Ficam ordenados **por transação** (ex.: PendingReference → Processed na Fase 7), não entre transações da mesma wallet.
- **Backfill na migration:**
  - com `add column … generated as identity`, as linhas existentes seriam numeradas na ordem física do heap;
  - por isso a migration numera por `(occurred_at, id)`, depois transforma a coluna em identity e ajusta a sequência (testado);
  - empates de `occurred_at` no mesmo agregado ficam na ordem do `id`. Isso só importa para eventos que estejam pendentes no momento do deploy.

**Limite de vazão por agregado:** no máximo **um evento por agregado por ciclo**, porque o 2º só fica elegível depois do commit do 1º.
- Lotes com agregados diferentes saem juntos.
- Uma wallet com uma rajada de eventos publica um evento por round-trip (claim + SendMessageBatch + commit), alguns ms em ambiente local.
- O teste com 50 `WalletBalanceChanged` de uma mesma wallet confere a ordem e que não há espera de intervalo entre eles.
- *Trade-off:* aceito em troca de ordem garantida sem coordenação entre publishers.

### Falha: backoff sem descarte

| Situação | Ação |
|---|---|
| Entrada recusada no `SendMessageBatch` (`Failed`) | só ela vai para `scheduleRetry` (testado com recusa real do LocalStack, `InvalidMessageContents`) |
| Entrada sem resposta (nem `Successful` nem `Failed`) | tratada como falha, nunca como publicada |
| Chamada inteira falha (rede, timeout, 5xx, fila inexistente) | `scheduleRetry` do lote todo |
| Chamada inteira recusada por erro do cliente (`$fault = client`, 4xx) | reenvia **uma a uma**, dentro do mesmo prazo: uma entrada "venenosa" não prende os outros agregados do lote |
| Falha do próprio ciclo (banco fora) | rollback; o loop pausa 1s·2^(n−1), até 30s |

- **Backoff** do domínio (`OutboxMessage.scheduleRetry`): 1s·2^(attempts−1), com teto de 5 min. `attempts` e `next_attempt_at` são gravados no mesmo commit.
- **Nunca há descarte nem DLQ para a outbox.**
  - Um evento confirmado não pode ser perdido (CHALLENGE §3).
  - Uma DLQ quebraria a ordem do agregado.
- A partir de `OUTBOX_STUCK_ATTEMPTS` tentativas (10, cerca de 8,5 min acumulados):
  - cada nova falha gera um log `error` `outbox_event_stuck`, com `eventId`, `aggregateId`, `eventType`, `attempts`, `nextAttemptAt` e `code`;
  - o evento passa a contar no gauge `wagering_outbox_stuck_events`.

**Um evento que falha para sempre bloqueia os seguintes do mesmo agregado.** É consequência direta da ordem por agregado; os outros agregados seguem normalmente.

Procedimento operacional:
1. **Alertas:**
   - `wagering_outbox_stuck_events > 0`, ou o log `outbox_event_stuck`;
   - `wagering_outbox_lag_seconds` acima do SLO.
2. **Diagnóstico** pelo `code` do log:
   - `InvalidMessageContents` ou `InvalidParameterValue`: payload ou atributo inválido, ou seja, bug no produtor do evento;
   - `batch_failed`, timeout ou erro de rede: problema de infraestrutura (SQS, rede, IAM).
3. **Infraestrutura:** basta corrigir a causa. O evento sai sozinho no próximo `next_attempt_at` (no máximo 5 min), e os seguintes do agregado vão atrás, em ordem.
4. **Payload inválido:** corrija o código e reprocesse.
   - Nunca apague a linha nem a marque como publicada à mão sem decidir o que o consumidor deve receber: isso perde o evento ou quebra a ordem.
   - Para antecipar a nova tentativa: `update outbox_messages set next_attempt_at = null where id = $eventId`.

### Timeouts: um SQS lento não segura locks

| Parâmetro | Default | Motivo |
|---|---|---|
| `OUTBOX_SQS_TIMEOUT_MS` | 3s | `AbortSignal.timeout` em `GetQueueUrl` e `SendMessageBatch` (testado: o sinal chega ao SDK real) |
| SDK do publisher | `maxAttempts: 1` | cliente SQS próprio (`OUTBOX_SQS_CLIENT`), porque o `abortSignal` não interrompe a espera entre retries internos do SDK. O retry com backoff fica com a outbox |
| `OUTBOX_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 15s | se o processo travar com o lock, o Postgres derruba a sessão e solta o lock (testado com 1s) |
| `statement_timeout` | 5s | limita o claim e os updates |
| Regra validada no boot | `sqs + 2000 ≤ idle` | a folga cobre o save e o commit depois do envio |

### Loop

- Se o claim trouxe algum evento (publicado ou reagendado), busca de novo **na hora**.
- Espera `OUTBOX_POLL_INTERVAL_MS` (500ms) **só quando o claim volta vazio**.
- Com o SQS fora, cada claim reagenda o próprio lote. Logo todos os pendentes ficam em backoff, o claim volta vazio e o loop passa a esperar: não há laço quente.

### Outbox lag

- `wagering_outbox_lag_seconds` = agora − `occurred_at` do pendente mais antigo, em segundos (0 sem pendentes). Vem da mesma query do gauge de eventos travados.
- É medido a cada ciclo vazio e, sob carga, no máximo uma vez por intervalo, para não varrer os pendentes a cada lote.
- Inclui eventos em backoff e os bloqueados atrás de um evento travado: é o atraso real visto pelo consumidor.

### Shutdown

`OutboxPublisherModule.beforeApplicationShutdown` roda antes de o ORM e os clientes SQS fecharem:
1. para de buscar e acorda a espera do intervalo (testado: `stop()` volta na hora, mesmo com intervalo de 60s);
2. espera o lote em andamento commitar, até `OUTBOX_SHUTDOWN_TIMEOUT_MS` (8s; a soma dos três prazos de shutdown cabe no orçamento de 25s, §21; testado);
3. se o prazo estourar:
   - loga `outbox_publisher_shutdown_timeout` e segue;
   - o lote abandonado não commita, e a sessão cai (pelo fechamento do pool ou pelo idle timeout);
   - outra instância republica o lote (testado).

### Limitações

- No máximo um evento por agregado por ciclo (ver acima).
- Cada publisher mantém uma conexão ocupada por lote: com N instâncias, até N conexões do pool, além das usadas pelo tráfego.

## 20. Worker de referências pendentes (Fase 7)

Transações que chegam antes da referência (ROLLBACK/REFUND antes da BET, WIN/LOSS antes da BET) ficam `PENDING_REFERENCE` (§8, §15). O `PendingReferenceWorker` as reprocessa com **as mesmas regras** da entrada: `WagerSettlement` (`src/application/wagering/wager-settlement.ts`) é a fonte única de "resolver referência + aplicar regras + gravar transação, saldo, ledger e outbox", usada pelo `ProcessWagerTransaction` (modo `insert`) e pelo `ResolvePendingReferences` (modo `update`).

### Fluxo

1. **Busca, sem lock**, numa transação curta (índice parcial `ix_wager_tx_reference_check_due`):
   ```sql
   select id, wallet_id, player_id from wager_transactions
   where status = 'PENDING_REFERENCE' and next_reference_check_at <= $now
   order by next_reference_check_at limit $batch   -- 10
   ```
2. **Por candidata**, uma transação SQL própria (com o `lock_timeout` de 2s do use case):
   1. wallet com `FOR UPDATE SKIP LOCKED` (ocupada → pula, `skipped{wallet_busy}`);
   2. a transação com `FOR UPDATE`, relida;
   3. se não estiver mais `PENDING_REFERENCE` ou não estiver vencida → pula (`not_due`): outra instância já tratou;
   4. `WagerSettlement.settle(..., 'update')`: `UPDATE ... WHERE id = ? AND status = 'PENDING_REFERENCE'` (0 linhas = bug, lança), saldo com `version`, ledger, outbox e o caminho rápido, tudo no mesmo commit.
3. **Resultado**:
   - referência PROCESSED → regras normais: PROCESSED (lançamento, `observedBalance`, `WagerTransactionProcessed` + `WalletBalanceChanged`) ou REJECTED com o código da regra (`AMOUNT_MISMATCH`, `REFERENCE_*_MISMATCH`, `REVERSAL_WOULD_OVERDRAW`, `REFERENCE_ALREADY_REVERSED`… avaliados **no momento da resolução**);
   - referência REJECTED/FAILED → `REFERENCE_NOT_PROCESSED`;
   - referência ausente ou ainda PENDING/PENDING_REFERENCE → nova tentativa (`attempts++`, backoff), **sem evento**;
   - prazo esgotado → REJECTED `REFERENCE_NOT_FOUND` + `WagerTransactionRejected`, no mesmo commit.

### Ordem de locks e deadlock

- Use case: wallet (`FOR UPDATE`) → INSERT da transação → UPDATE do caminho rápido (só pendentes **da mesma wallet**).
- Worker: wallet (`SKIP LOCKED`) → transação pendente (`FOR UPDATE`) → UPDATE da pendente → caminho rápido (mesma wallet).
- As duas ordens começam pela wallet, e nenhuma linha de outra wallet é travada: não há ciclo. O caminho rápido só roda quando a wallet foi travada; uma rejeição sem wallet do player (`WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH`) não antecipa nada, porque essa transação nunca serve de referência (a pendente veria `REFERENCE_PLAYER_MISMATCH`/`WALLET_MISMATCH` no próximo check normal).
- `SKIP LOCKED` na wallet: o worker não fica esperando atrás do tráfego de entrada nem de outra instância. Testado: dois workers sobre as mesmas pendentes e worker + use case em paralelo na mesma wallet → efeito único, sem deadlock.

### Backoff e expiração

| Item | Valor | Por quê |
|---|---|---|
| Backoff | `5s · 2^(n−1)`, teto 10min | o primeiro retry pega o caso comum (a referência atrasada segundos, em outra fila/instância); o teto limita a latência de resolução quando a referência chega tarde |
| Expiração | **TTL de 1h a partir do `createdAt`** (`PENDING_REFERENCE_TTL_MS`) | ver abaixo |
| Clamp | próxima checagem = `min(now + backoff, createdAt + TTL)` | a última tentativa cai exatamente no prazo (~13 tentativas em 1h) |
| Critério | `now >= createdAt + TTL` e a referência ainda não resolvida | |

Por que **TTL e não número de tentativas**:
- o caminho rápido e as referências encadeadas consomem tentativas de forma imprevisível; um limite por contagem expiraria cedo justamente as cadeias que estão andando;
- o TTL é tempo de relógio: não depende de o worker ter ficado parado (um worker que volta depois do prazo expira na primeira checagem, mas ainda resolve se a referência já estiver PROCESSED);
- 1h folga bem sobre a janela de retry do SQS (~7,5min até a DLQ, §18) e do HTTP; depois disso a referência só viria de reprocessamento manual, e o provedor precisa de uma resposta (`REFERENCE_NOT_FOUND` → reenviar referência e reversão como transações novas).

**Interpretação:** no prazo, a transação expira com `REFERENCE_NOT_FOUND` também quando a referência existe mas ainda está pendente (pedido explícito; o código diz "não resolvida a tempo"). Uma referência que chega depois não ressuscita a rejeição: o replay devolve o REJECTED original.

O TTL vale também para o use case (o primeiro agendamento já respeita o clamp): `WagerSettlement` recebe `ttlMs` da config nos dois caminhos.

### Caminho rápido

Quando uma transação vira terminal (use case **ou** worker), na mesma transação SQL:
```sql
update wager_transactions set next_reference_check_at = $now
where status = 'PENDING_REFERENCE' and provider_id = $p and reference_external_transaction_id = $ext
  and wallet_id = $w and next_reference_check_at > $now
```
- Só reduz latência: quem resolve continua sendo o worker, sob as regras normais. Não conta tentativa.
- `wallet_id = $w` vai além do pedido (provider + id externo): mantém o UPDATE dentro da wallet travada. Uma pendente de outra wallet só perde a antecipação.
- Disparado também pelo worker: resolver um REFUND antecipa o ROLLBACK que espera por ele (cadeias resolvem em ciclos seguidos, não no backoff).
- O trigger de guarda permite: o status não é terminal e nenhuma coluna de identidade muda (testado).

### Eventos: `correlationId` e `causationId`

- Coluna `correlation_id` (migration `…500000_correlation_id`), gravada no INSERT pelo use case (e pela abertura de wallet) e **imutável** (entra na tupla do trigger de guarda).
- Eventos do reprocessamento: `correlationId` = `correlation_id` da transação. **Fallback:** linhas anteriores à coluna (nulo) usam o `id` da transação.
- `causationId` = `eventId` do `WagerTransactionPendingReference` da transação (a resolução é consequência da pendência). **Fallback:** sem esse evento (não acontece pelo use case; só em linhas inseridas por fora), o `id` da transação. O `WalletBalanceChanged` continua causado pelo `WagerTransactionProcessed`.

### Replay

O replay (mesma key e payload) devolve o estado persistido: depois da resolução, o status final e o `observed_balance` **da resolução** (não o saldo atual). Pela fila, uma mensagem nova com a mesma key é replay e grava a inbox sem novo efeito (testado).

### Erros e heurísticas por candidata

- **Falha transitória** (lock timeout, deadlock, version, banco fora): `skipped{transient}`; a candidata continua vencida e volta no ciclo seguinte.
- **Erro inesperado** (bug, dado inconsistente): log `pending_reference_error` (só ids) + `skipped{error}` — **é o alerta**: sem intervenção, a candidata ficaria em PENDING_REFERENCE indefinidamente (e ocupando lugar no lote). Depois de **5 erros inesperados seguidos** da mesma candidata, o worker a encerra como **FAILED `INFRASTRUCTURE_FAILURE`** numa transação nova (lock da wallet com espera → lock da transação → ainda pendente? → `fail` + `WagerTransactionRejected` + caminho rápido), com `pending_reference_failed_total`. Falhas transitórias **não contam e não zeram** o contador; um sucesso zera.
- **Wallet muito ativa**: depois de **5 `wallet_busy` seguidos** da mesma candidata, a próxima tentativa espera o lock da wallet (`FOR UPDATE` com o `lock_timeout` de 2s) em vez de pular, para não adiar para sempre.
- Os dois contadores ficam **em memória, por instância**: são **heurística operacional, não garantia**. Zeram no restart, cada instância conta a sua parte (com N instâncias, encerrar como FAILED pode levar mais de 5 erros no total) e têm teto de 10 mil entradas. A correção não depende deles: decisões são tomadas sob lock, com releitura e UPDATE condicionado ao status no banco.
- `WagerTransactionRejected` passou a aceitar FAILED; o `failureCode` (`INFRASTRUCTURE_FAILURE`) distingue do REJECTED de negócio.

### Loop, flag e shutdown

| Variável | Padrão | Motivo |
|---|---|---|
| `PENDING_REFERENCE_WORKER_ENABLED` | true | liga o loop no boot (desligado no `.env.test`) |
| `PENDING_REFERENCE_BATCH_SIZE` | 10 | lote pequeno: cada candidata é uma transação; lote grande só atrasa o shutdown |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | 1000 | espera só quando o lote vem vazio **ou nenhuma candidata avançou** (todas puladas/erro): sem laço quente com wallet ocupada ou bug |
| `PENDING_REFERENCE_GAUGE_INTERVAL_MS` | 10000 | gauge de pendentes por intervalo, com ou sem carga |
| `PENDING_REFERENCE_TTL_MS` | 3600000 | prazo da referência (acima) |
| `PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS` | 8000 | soma dos três prazos de shutdown ≤ `SHUTDOWN_BUDGET_MS` (25s) < grace period de 30s (§21) |

- Mesmo padrão do outbox publisher (§19): `start`/`stop` no módulo, `stop` em `beforeApplicationShutdown` (antes de o ORM fechar), erro do ciclo inteiro (banco fora) → pausa `1s·2^(n−1)` até 30s.
- Shutdown: para **entre candidatas**; a candidata em andamento commita (testado). Prazo estourado: loga `pending_reference_worker_shutdown_timeout`; a transação abandonada sofre rollback quando o pool fecha e outra instância a reprocessa.
- **Limitação:** `start()` logo depois de um `stop()` que estourou o prazo é ignorado (`already_running`) enquanto o loop antigo termina. Só acontece no shutdown do processo.

### Limitações

- Erros inesperados repetidos em mais de `batchSize` candidatas ao mesmo tempo seguram o lote até cada uma atingir 5 erros e virar FAILED.
- Uma pendente cuja referência está numa **wallet diferente** não é antecipada (é rejeitada com `REFERENCE_WALLET_MISMATCH` no próximo check normal).

---

## 21. Estratégia de testes (Fase 9)

Postgres e LocalStack são **reais** em todas as suítes que não são unitárias (`docker compose up`). Nada mocka o banco nem a fila. Os testes de integração e de concorrência rodam no banco `wagering_test` (`.env.test`, com `NODE_ENV=test`). As filas são criadas com nome único por suíte e apagadas no fim.

### O que cada suíte prova

| Suíte | Comando | Prova | Tempo típico* |
|---|---|---|---|
| Unidade | `bun run test:unit` | `Money`, invariantes da `Wallet`, regras BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, payload divergente, máquina de estados, config (inclusive a recusa do `FAULT_INJECTION` fora de `NODE_ENV=test` e o orçamento de shutdown) | ~5s |
| Integração | `bun run test:integration` | migrations e constraints; **atomicidade** (trigger real que derruba uma gravação no meio do commit, tanto no use case quanto na resolução pelo worker de pendentes: nada persiste, e o reenvio aplica uma vez); inbox e redelivery; retry e DLQ; worker morto depois do commit e antes do ack (no processo); publishers concorrentes; recuperação de sessão morta (`pg_terminate_backend`, idle timeout); shutdown gracioso, inclusive com long polling em andamento | ~1 min |
| Concorrência | `bun run test:concurrency` | paralelismo real num processo: 80+80 sobre 100; a mesma BET 50x → 1 débito; mesma key em wallets diferentes; esgotar o saldo sem ficar negativo; dois publishers sobre a mesma outbox; dois workers de pendentes e worker + use case na mesma wallet | ~10s |
| Multi-instância | `bun run test:multi` | itens 1, 4, 5 e 8 do CHALLENGE §13 com **processos reais** (ver abaixo) | ~40s |

\* Máquina de desenvolvimento (Windows 11, Docker Desktop); o resumo das execuções está no `PROGRESSO.md`.

**Invariante final:** `wallet.balance == saldo reconstruído pelo ledger`. É verificado por `expectLedgerConsistent` nos testes que movem saldo (no `wagering-http`, por um `afterEach` sobre todas as wallets, exceto no teste que corrompe o saldo de propósito) e, no multi, por SQL sobre todas as wallets. No banco, o constraint trigger deferido saldo × último lançamento (§11) também barra a divergência no commit.

### Multi-instância (`test/multi`)

- **Processos:** `Instance` sobe `bun src/main.ts` com `Bun.spawn`: PID, pool de conexões e memória próprios. Cada instância roda API, consumidor SQS, outbox publisher e worker de pendentes, sobre o mesmo Postgres e o mesmo LocalStack. A saída do pino é lida continuamente e contada **por vida do processo**: `start()` zera os contadores, e linhas tardias de uma vida anterior só vão para a cauda de diagnóstico.
- **Roteiro:**
  1. **Item 5:** uma instância `F` com `FAULT_INJECTION=exit_after_commit_before_ack` processa um BET pelo SQS e se mata com SIGKILL depois do commit e antes do `DeleteMessage`. Fica provado por SQL (transação, lançamento, inbox e 3 eventos pendentes), pela mensagem ainda na fila e pela ausência de `sqs_message_acked` na `F`. Depois sobem A, B e C; a reentrega cai na inbox (`DUPLICATE_MESSAGE`), sem segundo débito.
  2. **Item 1 entre instâncias e canais:** a mesma aposta 50x em paralelo, sendo 30 por HTTP (10 em cada instância) e 20 por SQS (messageIds e grupos distintos, para as entregas correrem em paralelo). Resultado: 1 transação, 1 débito, um único `transactionId`.
  3. **Item 4, carga mista:** cenário 80+80 em duas instâncias; *hot wallet* com 120 BETs de 10,00 sobre 1000,00 (metade por HTTP, em rodízio nas 3 instâncias; metade por SQS no mesmo grupo) → exatamente 100 aceitas e 20 rejeitadas; duplicatas SQS (mesmo messageId com dedup do broker distinto); 12 wallets aleatórias pela seed. O teste **falha** se alguma das 3 instâncias não tiver atendido HTTP e confirmado mensagens SQS.
  4. **Item 8:** SIGKILL das 3 instâncias no meio da carga, reinício nas mesmas portas, onda 2 (REFUND/ROLLBACK antes da referência por HTTP e SQS, referência que nunca chega, replays em cada instância). O teste **falha** se alguma instância não atender HTTP e SQS depois do reinício.
  5. **Quiescência**, seguida das verificações finais, todas por SQL:
     - saldo == ledger e nenhum saldo negativo;
     - uma linha por idempotency key e no máximo um lançamento por transação;
     - nenhuma referência revertida duas vezes;
     - lançamentos só em PROCESSED que move saldo, com valor igual ao da transação;
     - toda transação terminal com exatamente um evento terminal do tipo certo, e todo lançamento com exatamente um `WalletBalanceChanged`;
     - outbox toda publicada, todo `eventId` na fila de eventos e nada a mais;
     - DLQ vazia e reconciliação HTTP consistente;
     - saldos finais iguais aos calculados **pelo teste**, de forma independente.
- **Por que o resultado não depende da ordem:** as cargas foram montadas para isso. Nas wallets aleatórias, a soma das 6 BETs pequenas cabe no saldo e as 2 grandes passam do saldo máximo possível. Na hot wallet, o saldo comporta exatamente 100 BETs. Qualquer intercalação dá o mesmo resultado final.
- **Docker:** o profile `multi` do compose (`docker compose --profile multi up -d --build --wait`) sobe 3 réplicas da imagem em `127.0.0.1:3000-3002`, com `stop_grace_period: 30s`. Ele valida empacotamento e shutdown; a suíte `test:multi` usa processos locais, que permitem SIGKILL e leitura de log por instância. Validação manual em 2026-11-07:
- build da imagem e `migrate` com saída 0;
- 3 réplicas `healthy` com `/health/ready` 200 em 3000, 3001 e 3002;
- `StopTimeout=30` e `NODE_ENV=production` nas três;
- no `down`, cada réplica registrou `pending_reference_worker_stopped`, `outbox_publisher_stopped` e `sqs_consumer_stopped` (nessa ordem: os hooks são sequenciais) e saiu com código 0, sem `shutdown_timeout`, em ~4s no total, com o long polling de produção (20s) abortado.

### Injeção de falha

- `FAULT_INJECTION=exit_after_commit_before_ack` é a única falha injetada no código de produção, no ponto exato entre o commit e o `DeleteMessage` do consumidor, e só para resultado `PROCESSED`.
- É aceita **só com `NODE_ENV=test`** (lista de permissão). Com `NODE_ENV` ausente, `production`, `prod`, `staging`, `TEST` ou qualquer outro valor, o `loadConfig` recusa e a aplicação não sobe (teste unitário). A imagem Docker fixa `NODE_ENV=production`.
- As demais falhas são injetadas **de fora**: triggers reais do Postgres criados só dentro do teste (atomicidade), `pg_terminate_backend`, filas inexistentes, cliente SQS com falha programada (`SpyQueueClient`) e use case embrulhado que devolve transitório ou lança.

### Determinismo

- **Sem sleep como sincronização:** toda espera é `eventually(condição, prazo)` com mensagem do que se esperava, ou espera por evento (`/health/ready`, saída do processo, sessão bloqueada em `pg_stat_activity`). Sobram só o backoff do cliente HTTP e um intervalo de 300ms entre as duas leituras da quiescência, porque as contagens do SQS são aproximadas.
- **Seed:** `MULTI_SEED` (inteiro; valor inválido derruba o teste) fixa os valores e a divisão HTTP/SQS da carga. A seed é impressa no início e, na falha, junto com o passo e a cauda de log de todas as instâncias (inclusive a `F`). A seed reproduz a **carga**, não a intercalação: o escalonamento entre processos não é determinístico, e por isso os resultados esperados independem da ordem.
- **Relógio manual:** nos testes do worker de pendentes e da outbox, o tempo avança por `ManualClock` e o ciclo roda via `runOnce()`.
- Processos filhos são mortos no `afterAll` e também no `exit` do `bun test`, mesmo se interrompido.

### Shutdown: orçamento

O Nest chama os `beforeApplicationShutdown` **módulo a módulo, em sequência** (`callBeforeShutdownHook` itera os módulos com `await`). Consumidor SQS, outbox publisher e worker de pendentes param um depois do outro, e o pior caso do shutdown é a **soma** dos três prazos.

| Variável | Padrão |
|---|---|
| `SQS_SHUTDOWN_TIMEOUT_MS` | 8000 |
| `OUTBOX_SHUTDOWN_TIMEOUT_MS` | 8000 |
| `PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS` | 8000 |
| `SHUTDOWN_BUDGET_MS` | 25000 |

**Regra:** `soma dos três timeouts ≤ SHUTDOWN_BUDGET_MS < stop_grace_period` (30s no compose). O `loadConfig` recusa a soma acima do orçamento, e a aplicação não sobe (teste unitário). Quem aumentar o `stop_grace_period` do orquestrador pode aumentar o orçamento junto.

**Por que 8s bastam:** cada componente só espera o trabalho em andamento. No consumidor, isso é o lote atual; o long poll em andamento é abortado (§18, com o trade-off). Na outbox, é um lote com envio limitado a 3s. No worker de pendentes, é uma candidata com `lock_timeout` de 2s. Estourado o prazo, o efeito continua seguro: a mensagem volta (visibilidade 0), o lote da outbox sofre rollback e é republicado, e a candidata é reprocessada por outra instância.

**Trade-off:** parar os três em paralelo num único hook daria até 25s para cada um, mas acoplaria módulos hoje independentes. Os prazos curtos atendem ao trabalho real.

### Limitações

- **Sobreposição não provada:** a disputa na hot wallet vem de 60 requisições HTTP simultâneas nas 3 instâncias (a metade SQS fica serializada pelo grupo FIFO). Como o resultado esperado não depende da ordem, o teste passaria igual se, por acaso, as requisições não se sobrepusessem. Provar a sobreposição de forma determinística exigiria instrumentação nova (por exemplo, exigir `wallet_lock_conflict` > 0, o que não é garantido). O cenário 80+80 e os testes de concorrência cobrem a disputa no lock com resultado verificável.
- **"Pegou trabalho em andamento" é sanidade, não prova:** no item 8, o teste exige fila ou outbox não vazias **imediatamente antes** do SIGKILL. Isso não prova que havia uma requisição HTTP em voo nem uma mensagem entre o commit e o ack no instante exato. Esse ponto é provado de forma determinística só pelo item 5, com a injeção de falha.
- **Distribuição da fila:** a exigência de que cada instância confirme mensagens SQS depende de o LocalStack distribuir as mensagens entre os consumidores. O teste usa `SQS_MAX_MESSAGES=1` e grupos distintos para tornar isso praticamente certo, mas não há garantia formal do broker.
- A seed não reproduz a intercalação entre processos (acima).
- O vínculo `SIGTERM` → shutdown hooks (`enableShutdownHooks`) foi verificado só na validação manual do profile `multi` do Docker (acima), não em teste automatizado.
- Algumas verificações finais repetem garantias do schema (reversão dupla, idempotency key duplicada). São intencionais: o teste não confia no schema para afirmar o resultado.
