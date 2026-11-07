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
| `wager-transactions.fifo` | FIFO, `ContentBasedDeduplication=false`, `VisibilityTimeout=30s`, `RedrivePolicy` → DLQ com `maxReceiveCount=5` |

- **Nomes:** `SQS_WAGER_QUEUE_NAME` / `SQS_WAGER_DLQ_NAME`, lidos pela aplicação **e** repassados pelo compose ao script de init, com os mesmos defaults (os nomes do CHALLENGE §10). Uma única fonte evita a aplicação procurar uma fila que o init nunca criou.
- **Sem dedup por conteúdo:** o produtor informa `MessageDeduplicationId` explícito. De qualquer forma, a dedup do broker é **otimização**; a garantia é a inbox persistente no Postgres (CHALLENGE §8).
  - *Trade-off:* todo produtor precisa gerar o dedup id; em troca, dois payloads idênticos legítimos não são descartados pelo broker por coincidência de conteúdo.
- **`maxReceiveCount=5`:** valor inicial, configurável por `SQS_MAX_RECEIVE_COUNT` (lido pelo compose; mudar exige recriar o container do LocalStack). Será revisto na Fase 5, junto com a classificação de erros (negócio / transitório / permanente).
  - *Trade-off:* baixo demais manda para a DLQ mensagens que sobreviveriam a uma indisponibilidade curta; alto demais atrasa a ida à DLQ de mensagens permanentemente inválidas.
- **`VisibilityTimeout=30s`:** folga ampla para uma transação curta no banco. A Fase 5 decide se o consumidor estende a visibilidade em processamento longo.
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
- `markPendingReference(now)` serve à entrada (vindo de `PENDING`) e às novas tentativas (`PENDING_REFERENCE → PENDING_REFERENCE`). Cada chamada incrementa `referenceAttempts` e agenda `nextReferenceCheckAt = now + min(5s · 2^(n−1), 10min)`. O limite de tentativas/TTL fica para a Fase 7. Só aceita transação que tenha referência.
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
| `REFERENCE_NOT_FOUND` | referência não apareceu até esgotar as tentativas de `PENDING_REFERENCE` | reenviar a referência e depois a reversão, como nova transação |
| `REFERENCE_NOT_PROCESSED` | referência terminou `REJECTED` ou `FAILED` (se está `PENDING`/`PENDING_REFERENCE`, a reversão **aguarda**, não é rejeitada) | desistir: não há o que reverter |
| `INVALID_REFERENCE_KIND` | `REFUND` sem ser de `BET`, ou `ROLLBACK` sem ser de `BET`/`WIN`/`REFUND` | corrigir o payload |
| `REFERENCE_ALREADY_REVERSED` | a referência já foi revertida pelo mesmo tipo de operação | desistir (já aplicado) |
| `AMOUNT_MISMATCH` | valor da reversão ≠ valor da referência (não há reversão parcial) | corrigir o payload |
| `REFERENCE_ROUND_MISMATCH` | referência de outra rodada | corrigir o payload |
| `REFERENCE_PLAYER_MISMATCH` | referência de outro player | corrigir o payload |
| `REFERENCE_WALLET_MISMATCH` | referência de outra wallet | corrigir o payload |
| `INFRASTRUCTURE_FAILURE` | erro permanente de infraestrutura (status `FAILED`, auditável) | reenviar mais tarde com nova transação |

- Não existe código de "referência de outro provider": a referência é resolvida por `(providerId, referenceExternalTransactionId)`, então outro provider resulta em `REFERENCE_NOT_FOUND`.
- A mesma idempotency key com payload diferente **não** é `failureCode`: é um conflito de requisição (HTTP 409, Fase 4) e não cria transação.
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

Todas criadas em `Migration20261107100000_schema` e provadas uma a uma em `test/integration/persistence/schema-constraints.test.ts`. Duplicam de propósito as verificações do domínio.

| Garantia | Onde o banco aplica |
|---|---|
| Uma wallet por `(player_id, currency)` | `uq_wallets_player_currency` |
| Saldo nunca negativo | `ck_wallets_balance_non_negative`, `ck_ledger_balance_before`, `ck_ledger_balance_after`, `ck_wager_tx_observed_balance` |
| `version >= 1` | `ck_wallets_version` |
| Moeda ISO de 3 letras | `ck_wallets_currency`, `ck_wager_tx_currency` (e as FKs de moeda) |
| Toda mudança de saldo tem lançamento, e vice-versa | constraint triggers deferidos `trg_wallets_balance_matches_ledger` e `trg_ledger_balance_matches_wallet`: no COMMIT, `wallets.balance` = `balance_after` do último lançamento (por `seq`), ou 0 sem lançamentos |
| Idempotência por key | `uq_wager_tx_idempotency_key` |
| Uma transação por `(provider_id, external_transaction_id)` | `uq_wager_tx_provider_external` |
| `kind`, `status`, `failure_code` nos valores do domínio | `ck_wager_tx_kind`, `ck_wager_tx_status`, `ck_wager_tx_failure_code` |
| Valor ≥ 0, e > 0 nos kinds que movem saldo | `ck_wager_tx_amount` |
| `REFUND`/`ROLLBACK` exigem referência externa | `ck_wager_tx_reference_required` |
| `PROCESSED` ⇔ `processed_at`; `PROCESSED` exige saldo observado; reversão `PROCESSED` exige referência interna | `ck_wager_tx_processed`, `ck_wager_tx_processed_balance`, `ck_wager_tx_processed_reference` |
| `REJECTED`/`FAILED` ⇔ `failure_code` | `ck_wager_tx_failure` |
| `PENDING_REFERENCE` tem referência e agendamento | `ck_wager_tx_pending_reference` |
| Moeda da transação = moeda da wallet (exceto rejeitadas/falhas) | `fk_wager_tx_wallet_currency` sobre a coluna gerada `wallet_fk_currency` |
| Referência interna existe e é da mesma wallet | `fk_wager_tx_reference` → `uq_wager_tx_id_wallet` |
| Uma reversão `PROCESSED` por referência e por tipo | índice único parcial `ux_wager_tx_one_reversal_per_kind` |
| Transação terminal não muda; identidade/payload nunca mudam; transação nunca é apagada | trigger `trg_wager_transactions_guard` (BEFORE UPDATE OR DELETE) |
| Ledger append-only | trigger `trg_ledger_append_only` (BEFORE UPDATE OR DELETE) |
| Aritmética do lançamento | `ck_ledger_arithmetic`, `ck_ledger_amount_positive`, `ck_ledger_direction` |
| No máximo um lançamento por transação e wallet | `uq_ledger_wallet_transaction` |
| Moeda do lançamento = moeda da wallet | `fk_ledger_wallet_currency` → `uq_wallets_id_currency` |
| Lançamento pertence a uma transação da mesma wallet | `fk_ledger_transaction` → `uq_wager_tx_id_wallet` |
| Cursor estável do ledger | `seq bigint generated always as identity` + `uq_ledger_wallet_seq` |
| Inbox única por consumidor e mensagem | `pk_inbox_messages (consumer_name, message_id)` |
| Outbox: tentativas ≥ 0 | `ck_outbox_attempts` |

Índices para os workers: `ix_wager_tx_reference_check_due (next_reference_check_at) WHERE status='PENDING_REFERENCE'` (Fase 7), `ix_wager_tx_awaiting_reference (provider_id, reference_external_transaction_id) WHERE status='PENDING_REFERENCE'` (destravar pendentes quando a referência chega) e `ix_outbox_pending (next_attempt_at) WHERE published_at IS NULL` (Fase 6).

**Limitações conhecidas:**
- Saldo × ledger compara com o **último** lançamento, não com a soma de todos (a soma completa é a reconciliação da Fase 4). O encadeamento `balance_before` = `balance_after` do lançamento anterior não é verificado pelo banco; quem o garante é o domínio (`Wallet.apply`) mais o lock por wallet da Fase 3.
- O banco não verifica que só transação `PROCESSED` tenha lançamento, nem que o valor do lançamento seja igual ao da transação. Quem garante isso é o use case da Fase 3.
