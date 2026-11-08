# Arquitetura

Decisões técnicas do processador de apostas: o que foi escolhido, por quê e o que custou. A especificação é o [`CHALLENGE.md`](CHALLENGE.md); setup e comandos estão no [`README.md`](README.md).

As seções não são numeradas: código e configuração citam uma seção pelo nome (por exemplo, `ARCHITECTURE.md → "Concorrência"`). Renomear uma seção exige atualizar essas citações (`grep -rn 'ARCHITECTURE.md →'`).

## Índice

1. [Visão geral em 1 minuto](#visão-geral-em-1-minuto)
2. [Stack e estrutura](#stack-e-estrutura)
3. [Infraestrutura local](#infraestrutura-local)
4. [Persistência](#persistência)
5. [Modelo de domínio](#modelo-de-domínio)
6. [Garantias no schema](#garantias-no-schema)
7. [Estratégia transacional](#estratégia-transacional)
8. [Concorrência](#concorrência)
9. [Idempotência](#idempotência)
10. [Regras de negócio](#regras-de-negócio)
11. [Taxonomia de failureCode](#taxonomia-de-failurecode)
12. [API HTTP](#api-http)
13. [Autenticação](#autenticação)
14. [Consumidor SQS](#consumidor-sqs)
15. [Outbox publisher](#outbox-publisher)
16. [Worker de referências pendentes](#worker-de-referências-pendentes)
17. [Observabilidade](#observabilidade)
18. [Estratégia de testes](#estratégia-de-testes)
19. [Configuração](#configuração)
20. [Interpretações adotadas](#interpretações-adotadas)
21. [Pontos da especificação que geraram dúvida](#pontos-da-especificação-que-geraram-dúvida)
22. [Decisões, trade-offs e limitações](#decisões-trade-offs-e-limitações)

---

## Visão geral em 1 minuto

Provedores enviam `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` por HTTP ou pela fila `wager-transactions.fifo`. As duas entradas chamam **o mesmo use case** (`ProcessWagerTransaction`). Qualquer número de instâncias roda o mesmo processo (API, consumidor, outbox publisher e worker de pendentes) sobre um único Postgres.

**Uma BET pela API** (`POST /wagering/transactions` com `Idempotency-Key`):

1. `AuthGuard` (no-op hoje) → validação do corpo (`400`; nada é gravado) → cálculo do `payloadHash`.
2. **Uma transação SQL:** `SET LOCAL lock_timeout = 2s` → `SELECT … FROM wallets … FOR UPDATE` → busca pela key ou pelo id externo (se existir: replay ou `409`) → regras de negócio → `INSERT` da transação → `UPDATE` do saldo conferindo `version` → `INSERT` do lançamento → `INSERT` dos eventos na outbox → `COMMIT`, quando as FKs deferidas e o trigger saldo × ledger são checados.
3. Resposta: `200` PROCESSED, `422` REJECTED/FAILED, `202` PENDING_REFERENCE, `409` conflito de idempotência, `503` falha transitória (reenviar com a mesma key).

**A mesma BET pela fila:** `ReceiveMessage` → envelope inválido vai para a DLQ → pré-checagem da inbox → o mesmo use case, com a linha da inbox gravada **na mesma transação SQL** → `DeleteMessage` só depois do commit. Uma falha transitória volta para a fila com backoff; na 5ª tentativa, ou com payload inválido, vai para a DLQ com motivo.

**Depois do commit:** o outbox publisher trava eventos pendentes com `FOR UPDATE SKIP LOCKED`, publica em `wager-events.fifo` e os marca como publicados no mesmo commit. O worker de pendentes reprocessa as `PENDING_REFERENCE`, com as mesmas regras, até o TTL de 1h.

**Onde está cada garantia:**

| Garantia | Mecanismo | Seção |
|---|---|---|
| Dinheiro exato | `Money` em `bigint` de centavos e `numeric(20,2)` no banco; nunca `number` | [Modelo de domínio](#modelo-de-domínio), [Persistência](#persistência) |
| Sem débito ou crédito duplicado | unicidade de `(provider_id, idempotency_key)` e `(provider_id, external_transaction_id)`, checada sob o lock; inbox única por `(consumer_name, message_id)` | [Idempotência](#idempotência) |
| Sem saldo negativo nem lost update | `FOR UPDATE` por wallet, `version` no `UPDATE` e `CHECK (balance >= 0)` | [Concorrência](#concorrência), [Garantias no schema](#garantias-no-schema) |
| Atomicidade | transação, saldo, ledger, inbox e outbox no mesmo commit | [Estratégia transacional](#estratégia-transacional) |
| Ledger auditável | append-only por trigger; saldo × último lançamento checado no commit; reconciliação sob demanda | [Garantias no schema](#garantias-no-schema), [API HTTP](#api-http) |
| Evento nunca antes do commit, nunca perdido | outbox no mesmo commit; publisher at-least-once com `eventId` estável | [Outbox publisher](#outbox-publisher) |
| Várias instâncias | nenhuma garantia depende de memória; locks no banco; `SKIP LOCKED` nos workers | [Concorrência](#concorrência), [Estratégia de testes](#estratégia-de-testes) |

---

## Stack e estrutura

- **Bun 1.4** como runtime, gerenciador de pacotes e test runner. O Bun executa TypeScript direto, sem build. Quem garante os tipos é o `bun run typecheck` (`tsc --noEmit`), porque o Bun não checa tipos.
- **TypeScript estrito**, incluindo `noUncheckedIndexedAccess` e `exactOptionalPropertyTypes`: acesso a índice devolve `T | undefined` e opcional não aceita `undefined` implícito. Isso importa para que valores monetários e ids não "sumam" silenciosamente.
- **Camadas** `domain` → `application` → `infrastructure` / `interfaces`. O domínio não importa NestJS nem ORM. As portas (interfaces) ficam em `application/ports` e os adaptadores, em `infrastructure`. Lógica de aplicação sem framework (use cases, `ReadinessService`) fica em `application` e é instanciada pelos módulos Nest via factory.
- **Configuração** validada no boot (`loadConfig`). Uma variável ausente ou inválida derruba o processo antes de aceitar tráfego, e todos os problemas são reportados de uma vez. Isso inclui credenciais AWS pela metade, que fariam o SDK cair silenciosamente na cadeia padrão. Lista completa em [Configuração](#configuração).
- **Módulos Nest** por responsabilidade; o `AppModule.register(config)` só compõe. Ele recebe a config pronta, o que permite aos testes subir a aplicação contra outro banco ou endpoint sem mexer em `process.env`.

  | Módulo | Responsabilidade |
  |---|---|
  | `ConfigModule` (global) | `APP_CONFIG`, a config já validada |
  | `PersistenceModule` | MikroORM e `PostgresReadinessCheck` |
  | `MessagingModule` | `SQSClient` (fechado no shutdown) e `SqsReadinessCheck` |
  | `HealthModule` | `/health/live`, `/health/ready` e `ReadinessService` |
  | `MetricsModule` | registry de métricas e `GET /metrics` |
  | `WageringCoreModule` | use cases instrumentados (`ProcessWagerTransaction`, `OpenWallet`), compartilhados por HTTP e SQS |
  | `WageringModule` | controller HTTP, `AuthGuard` e consultas |
  | `WagerConsumerModule` | consumidor SQS |
  | `OutboxPublisherModule` | outbox publisher |
  | `PendingReferenceWorkerModule` | worker de referências pendentes |

## Infraestrutura local

| Serviço | Imagem | Observação |
|---|---|---|
| PostgreSQL | `postgres:16.10-alpine` | o init cria o banco `wagering_test`, isolado do banco de desenvolvimento |
| LocalStack | `localstack/localstack:4.9.2` | só SQS, com versão fixada |

- **Portas publicadas só em `127.0.0.1`.** As credenciais locais são fixas e conhecidas, então nem o Postgres nem a fila de entrada ficam expostos à rede.
- **LocalStack com versão fixa:** as versões recentes da imagem passaram a exigir auth token, e a 4.9.2 roda sem conta. Alternativa registrada, caso deixe de funcionar: **MiniStack**, aceito pelo desafio.
- **O healthcheck do LocalStack** só fica verde quando o init terminou **e** todos os scripts terminaram com `SUCCESSFUL`. `"completed": true` sozinho não basta, porque um script com erro também completa. Assim, `docker compose up --wait` garante que as filas existem.
- **`.gitattributes` força LF.** No Windows, o Git converteria o script de init para CRLF, e o bash do container quebraria.
- **Testes** usam o `.env.test`, carregado automaticamente pelo `bun test` com `NODE_ENV=test`. O arquivo é completo por conta própria, não depende do `.env` do desenvolvedor e é versionado com **somente** valores locais.
- **Profile `multi`** do compose: o serviço `migrate` e 3 réplicas da imagem (`Dockerfile`, `oven/bun:1.4`, `NODE_ENV=production`) em `127.0.0.1:3000-3002`, com `stop_grace_period: 30s` (ver [Estratégia de testes](#estratégia-de-testes)).

### Filas

| Fila | Atributos |
|---|---|
| `wager-transactions-dlq.fifo` | FIFO, `ContentBasedDeduplication=false`, retenção de 14 dias |
| `wager-transactions.fifo` | FIFO, `ContentBasedDeduplication=false`, `VisibilityTimeout=30s`, `RedrivePolicy` → DLQ com `maxReceiveCount=10` |
| `wager-events.fifo` | FIFO, `ContentBasedDeduplication=false`, retenção de 14 dias, **sem DLQ**; destino do [outbox publisher](#outbox-publisher) |

- **Nomes:** `SQS_WAGER_QUEUE_NAME`, `SQS_WAGER_DLQ_NAME` e `SQS_WAGER_EVENTS_QUEUE_NAME` são lidos pela aplicação **e** repassados pelo compose ao script de init, com os mesmos defaults (os nomes do CHALLENGE §10). Com uma fonte só, a aplicação não procura uma fila que o init nunca criou.
- **Sem dedup por conteúdo:** o produtor informa um `MessageDeduplicationId` explícito. A dedup do broker é só **otimização**; a garantia é a inbox persistente no Postgres.
- **`maxReceiveCount=10`:** rede de segurança acima do limite do consumidor, que é 5 (era 5 na Fase 0 e foi revisto na Fase 5; motivo em [Consumidor SQS](#consumidor-sqs)). É configurável por `SQS_MAX_RECEIVE_COUNT`, lido só pelo compose; mudar exige recriar o container do LocalStack.
- **`VisibilityTimeout=30s`** é só o default da fila. O consumidor pede 60s em cada `ReceiveMessage` e não estende a visibilidade durante o processamento.
- **Criação:** o script `docker/localstack/init/ready.d/01-create-queues.sh` valida nomes e `maxReceiveCount` antes de usá-los. Ele é idempotente para os mesmos atributos. Com atributos diferentes numa fila existente, a criação falha; isso não ocorre hoje, porque o compose não persiste o estado do LocalStack.

## Persistência

### ORM: MikroORM 6

**Escolha:** MikroORM, a opção preferencial do desafio. Unit of Work e Identity Map explícitos, `em.transactional()` e `LockMode` nativos são as ferramentas que a [estratégia transacional](#estratégia-transacional) e a [de concorrência](#concorrência) usam.

**Contexto do EntityManager: uma regra só para todas as entradas.**
- `allowGlobalContext: false` proíbe usar o `EntityManager` global (identity map compartilhado entre requisições).
- `registerRequestContext: false` desliga o contexto implícito por request HTTP do `@mikro-orm/nestjs`.
- Resultado: HTTP, consumidor SQS e workers seguem a mesma regra. Todo use case abre o próprio contexto (`em.fork()` / `em.transactional()`), e não há comportamento diferente entre a entrada HTTP (que teria contexto "de graça") e os workers (que lançariam erro).

**Conexão preguiçosa (`connect: false`, só na aplicação):** a instância sobe mesmo com o Postgres fora; o `/health/ready` reporta `not_ready`, e o tráfego não chega até o banco voltar. Com conexão eager, uma queda do banco derrubaria o boot de todas as instâncias, que entrariam em crash loop. O CLI de migrations continua com conexão eager, para falhar rápido.

**Pool:** `max: 10` por instância e `acquireTimeoutMillis: 10s`. Com N instâncias, o total é N × 10; o `max_connections` padrão do Postgres (100) comporta folgadamente 3 ou mais instâncias, com os workers. O acquire timeout curto faz a requisição falhar como erro transitório quando o banco está fora, em vez de empilhar por 60s (default do tarn).

### Mapeamento: registros de persistência e mappers

- Cada tabela tem uma classe de registro simples (`WalletRecord`, `WagerTransactionRecord`, `LedgerEntryRecord`, `InboxMessageRecord`, `OutboxMessageRecord`), mapeada por `EntitySchema` em `src/infrastructure/persistence/*.persistence.ts`. Wallet, transação e lançamento têm o par `toXRecord(domínio)` / `toX(registro)`; a volta sempre passa pelo `rehydrate` do domínio.
- **Inbox e outbox têm um único mapeador cada, o de escrita** (`toInboxMessageRecord`, `toOutboxMessageRecord`), porque produção nunca as lê como registro ORM: a inbox só é consultada pelo hash (`InboxLookup`), e a outbox é lida pelo claim em SQL cru do `OutboxStore`, que reidrata a linha com `OutboxMessage.rehydrate`. Um segundo mapeador de leitura só serviria aos testes e teria de ser mantido em sincronia; o teste de round-trip lê pelos mesmos caminhos de produção.
- **Por que não mapear as classes de domínio direto:** o MikroORM hidrataria campos privados (`_balance`, `_status`) sem passar pelo `rehydrate`, e o `Money` exigiria um embeddable ou custom type acoplado ao ORM. As classes de domínio ficam sem decorators e sem nenhum import de ORM (CHALLENGE §6.1).
- Os registros não têm relações ORM: as FKs são colunas `string`. Isso funciona porque **todas as FKs entre tabelas são `DEFERRABLE INITIALLY DEFERRED`**: são checadas no COMMIT, então a ordem de INSERT escolhida pelo flush não importa (há teste que persiste os lançamentos antes da transação e da wallet).
- Colunas geradas pelo banco e não mapeadas: `wallet_ledger_entries.seq` (cursor do ledger) e `wager_transactions.wallet_fk_currency` (ver [Garantias no schema](#garantias-no-schema)).

### Mapeamento do `Money`

Cada valor é uma coluna `numeric(20,2)`, e a moeda fica na coluna `currency char(3)` da linha (`wallets`, `wager_transactions`, `wallet_ledger_entries`). O MikroORM mapeia com `type: 'decimal', runtimeType: 'string'`, e o driver `pg` já entrega `numeric` como string. O valor nunca passa por `number`: a leitura é `Money.from({ amount: <string do banco>, currency })`, e a escrita grava `money.amount` (string com 2 casas). O limite do `Money` (18 dígitos inteiros) é o mesmo do `numeric(20,2)`. O round-trip de `"0.10"` e `"99999999999999.99"` é testado em `test/integration/persistence/round-trip.test.ts`.

### Saldo observado

O replay devolve o saldo daquele momento (CHALLENGE §7.7), mas `LOSS` e as rejeições não têm lançamento de onde tirá-lo. Por isso a `WagerTransaction` tem `observedBalance` (coluna `observed_balance`), na moeda da transação. Ele é obrigatório em `markProcessed` (há CHECK para `PROCESSED`) e opcional em `reject`. Fica ausente quando não há wallet na moeda da transação (`WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`).

### Migrations

- Executadas por um CLI próprio (`src/infrastructure/persistence/migrate.ts`) que usa `orm.getMigrator()`, para não depender do CLI do MikroORM rodando sob Bun (resolução de config TS, ts-node etc.).
  - Os argumentos são validados **antes** de conectar: comando ou opção desconhecida e nome inválido saem com código 1 e a mensagem de uso.
  - O nome vira parte do nome da classe TS, por isso só aceita `[A-Za-z0-9_]`: um `add-wallets` geraria um arquivo que quebra todas as migrations.
- **Escritas à mão em SQL** (`snapshot: false`, sem geração por diff). O schema (constraints, índices, triggers) é parte do que é avaliado e precisa ser explícito e revisável, não derivado das entidades.
- `transactional: true` e `allOrNothing: true`: um lote de migrations aplica inteiro ou nada.
- Toda migration tem `down`. O ciclo up → down → up é testado em `test/integration/infrastructure/migrations.test.ts`, e o CLI, em `migrate-cli.test.ts`. A migration `baseline` é vazia de propósito; as tabelas nascem em `…100000_schema`.
- Uma migration aplicada nunca é editada: mudanças entram em migrations novas (`…200000_one_reversal_per_reference`, `…300000_idempotency_per_provider`, `…310000_balance_limit_failure_code`, `…400000_outbox_seq`, `…500000_correlation_id`), cada uma com `down` que restaura o estado anterior.

## Modelo de domínio

**Regra geral:** construtor privado e factories (`create`/`open`/`receive`/`enqueue` validam; `rehydrate` só reconstrói, sem revalidar). Ids e datas são **injetados** pelo chamador: o domínio não gera UUID nem lê relógio, o que mantém os testes determinísticos.

### `Money`

**Escolha:** `bigint` em **centavos**, escala fixa de 2, numa classe imutável (`Object.freeze`) com construtor privado. É exato, nativo do runtime e sem dependência. Como o domínio só soma, subtrai e compara (sem divisão, juros nem câmbio), uma lib decimal de precisão arbitrária não traria ganho. A string de entrada é validada por regex e convertida direto para `bigint`, sem passar por `number`. O modelo é multi-moeda: `currency` faz parte do valor.

**Contrato de entrada** (`Money.from({ amount, currency })`):
- `amount` precisa ser uma **string** que case com `^(0|[1-9]\d{0,17})(\.\d{1,2})?$`. Isso rejeita string vazia, espaços, `NaN`, `Infinity`, notação científica, sinal (`-` ou `+`), mais de 2 casas, vírgula, zeros à esquerda e **mais de 18 dígitos inteiros** (limite do `numeric(20,2)`). Um `number` em runtime também é rejeitado.
- `"25"` e `"25.5"` **são aceitos** e **sempre serializados com 2 casas** (`"25.00"`, `"25.50"`). O `toJSON()` devolve `{ amount: "25.00", currency: "BRL" }`, o formato de todos os contratos e eventos.
- `currency` precisa ser um código ISO-4217 de 3 letras maiúsculas.

**Operações:** `add`, `subtract` e `isLessThan` entre moedas diferentes lançam `CurrencyMismatchError`; `equals` entre moedas diferentes devolve `false`. `subtract` e `negate` podem gerar valor negativo (usado em comparações e na aritmética do ledger), mas nenhuma *entrada* é negativa. Um resultado além de ±18 dígitos inteiros lança `InvalidMoneyError`, para que o domínio nunca produza algo que o `numeric(20,2)` não aceite.

### Máquina de estados da `WagerTransaction`

```
              ┌──────────────────────┐
              │                      ▼
PENDING ──► PENDING_REFERENCE ──► PENDING_REFERENCE (nova tentativa, backoff)
   │              │
   ├──────────────┴──► PROCESSED   (terminal)
   ├──────────────┴──► REJECTED    (terminal, com failureCode)
   └──────────────┴──► FAILED      (terminal, com failureCode)
```

- `create` nasce em `PENDING`. Rejeita `OPENING` (interno, criado só por `WagerTransaction.opening`, que já nasce `PROCESSED`), exige `referenceExternalTransactionId` não vazio em `REFUND`/`ROLLBACK`, exige valor > 0 nos kinds que movem saldo e aceita valor ≥ 0 em `LOSS`.
- `markPendingReference(now)` serve à entrada (vindo de `PENDING`) e às novas tentativas (`PENDING_REFERENCE → PENDING_REFERENCE`). Cada chamada incrementa `referenceAttempts` e agenda `nextReferenceCheckAt = now + min(5s · 2^(n−1), 10min)`, limitado ao prazo da referência (ver [Worker de referências pendentes](#worker-de-referências-pendentes)). Só aceita transação que tenha referência.
- `markProcessed(referenceTransactionId, at, observedBalance)` exige o id interno da referência em `REFUND`/`ROLLBACK` e o saldo observado; `reject(code, observedBalance?)` aceita o saldo como opcional.
- Qualquer transição a partir de `PROCESSED`, `REJECTED` ou `FAILED` lança `InvalidTransactionStateError`: é erro de programação, não caminho de negócio. O banco também impede (trigger de guarda).
- **Direção no ledger** (`ledgerDirectionFor`): `BET` → DEBIT; `WIN`, `REFUND` e `OPENING` → CREDIT; `LOSS` não gera lançamento; `ROLLBACK` inverte a direção da referência, que precisa ser `BET`, `WIN` ou `REFUND`.
- `matchesPayload(hash)` distingue *replay* (mesmo hash) de *conflito* (mesma key, payload diferente).

### `Wallet`, ledger, inbox e outbox

- **Wallet:** `open` devolve a wallet com `version = 1` e o lançamento CREDIT da transação OPENING (saldo inicial zero não gera lançamento). Cada `debit`/`credit` cria o lançamento **antes** de mutar o estado (se o lançamento for inválido, a wallet não muda), devolve o `WalletLedgerEntry` e incrementa `version` em 1. `version` só muda quando o saldo muda.
- **`WalletLedgerEntry.create`** verifica valor > 0, mesma moeda, saldos ≥ 0 e `balanceBefore ± money = balanceAfter`.
- **Outbox:** `scheduleRetry` usa `min(1s · 2^(attempts−1), 5min)`, determinístico e sem jitter (o espalhamento entre instâncias vem do `SKIP LOCKED`). O id da mensagem é o `eventId`, para que publicações duplicadas sejam deduplicáveis pelo consumidor.
- **Eventos de integração:** `WagerTransactionProcessed` (inclusive LOSS), `WalletBalanceChanged` (só com lançamento, inclui `walletVersion`), `WagerTransactionRejected` (REJECTED e FAILED; o `failureCode` distingue) e `WagerTransactionPendingReference`.

## Garantias no schema

Criadas em `Migration20261107100000_schema` (e nas migrations seguintes, quando indicado) e provadas uma a uma em `test/integration/persistence/schema-constraints.test.ts`. **Duplicam de propósito** as verificações do domínio.

| Garantia | Onde o banco aplica |
|---|---|
| Uma wallet por `(player_id, currency)` | `uq_wallets_player_currency` |
| Saldo nunca negativo | `ck_wallets_balance_non_negative`, `ck_ledger_balance_before`, `ck_ledger_balance_after`, `ck_wager_tx_observed_balance` |
| `version >= 1` | `ck_wallets_version` |
| Moeda ISO de 3 letras | `ck_wallets_currency`, `ck_wager_tx_currency` (e as FKs de moeda) |
| Toda mudança de saldo tem lançamento, e vice-versa | constraint triggers deferidos `trg_wallets_balance_matches_ledger` e `trg_ledger_balance_matches_wallet`: no COMMIT, `wallets.balance` = `balance_after` do último lançamento (por `seq`), ou 0 sem lançamentos |
| Idempotência por key, escopada por provider | `uq_wager_tx_provider_idempotency_key (provider_id, idempotency_key)` (`…300000`) |
| Uma transação por `(provider_id, external_transaction_id)` | `uq_wager_tx_provider_external` |
| `kind`, `status`, `failure_code` nos valores do domínio | `ck_wager_tx_kind`, `ck_wager_tx_status`, `ck_wager_tx_failure_code` (`…310000` acrescenta `BALANCE_LIMIT_EXCEEDED`) |
| Valor ≥ 0, e > 0 nos kinds que movem saldo | `ck_wager_tx_amount` |
| `REFUND`/`ROLLBACK` exigem referência externa | `ck_wager_tx_reference_required` |
| `PROCESSED` ⇔ `processed_at`; `PROCESSED` exige saldo observado; reversão `PROCESSED` exige referência interna | `ck_wager_tx_processed`, `ck_wager_tx_processed_balance`, `ck_wager_tx_processed_reference` |
| `REJECTED`/`FAILED` ⇔ `failure_code` | `ck_wager_tx_failure` |
| `PENDING_REFERENCE` tem referência e agendamento | `ck_wager_tx_pending_reference` |
| Moeda da transação = moeda da wallet (exceto rejeitadas/falhas) | `fk_wager_tx_wallet_currency` sobre a coluna gerada `wallet_fk_currency` |
| Referência interna existe e é da mesma wallet | `fk_wager_tx_reference` → `uq_wager_tx_id_wallet` |
| Uma reversão `PROCESSED` por referência, no total | índice único parcial `ux_wager_tx_one_reversal (reference_transaction_id) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')` (`…200000`) |
| Transação terminal não muda; identidade, payload e `correlation_id` nunca mudam; transação nunca é apagada | trigger `trg_wager_transactions_guard` (BEFORE UPDATE OR DELETE) |
| Ledger append-only | trigger `trg_ledger_append_only` (BEFORE UPDATE OR DELETE) |
| Aritmética do lançamento | `ck_ledger_arithmetic`, `ck_ledger_amount_positive`, `ck_ledger_direction` |
| No máximo um lançamento por transação e wallet | `uq_ledger_wallet_transaction` |
| Moeda do lançamento = moeda da wallet | `fk_ledger_wallet_currency` → `uq_wallets_id_currency` |
| Lançamento pertence a uma transação da mesma wallet | `fk_ledger_transaction` → `uq_wager_tx_id_wallet` |
| Cursor estável do ledger | `seq bigint generated always as identity` + `uq_ledger_wallet_seq` |
| Inbox única por consumidor e mensagem | `pk_inbox_messages (consumer_name, message_id)` |
| Outbox: tentativas ≥ 0; ordem por agregado | `ck_outbox_attempts`; `seq` identity + `uq_outbox_seq` (`…400000`) |

**Índices para os workers:** `ix_wager_tx_reference_check_due (next_reference_check_at) WHERE status='PENDING_REFERENCE'`, `ix_wager_tx_awaiting_reference (provider_id, reference_external_transaction_id) WHERE status='PENDING_REFERENCE'` (caminho rápido), `ix_outbox_pending (next_attempt_at) WHERE published_at IS NULL` e `ix_outbox_pending_aggregate (aggregate_id, seq) WHERE published_at IS NULL`.

**Rejeições que o schema precisa aceitar:**
- `REJECTED`/`FAILED` ficam isentas da FK `(wallet_id, currency) → wallets`: a coluna gerada `wallet_fk_currency` é `NULL` nesses status, e com MATCH SIMPLE a FK não é checada. Sem isso, `WALLET_NOT_FOUND` e `CURRENCY_MISMATCH` não poderiam ser gravadas, e precisam ser, para auditoria e replay. Nos outros status, a FK vale integralmente.
- Em rejeições `REFERENCE_*_MISMATCH` grava-se **só** `reference_external_transaction_id`, com `reference_transaction_id` `NULL`: a FK composta `(reference_transaction_id, wallet_id)` impediria o insert de uma referência de outra wallet. O id interno só é obrigatório (CHECK) em `REFUND`/`ROLLBACK` `PROCESSED`.

**Códigos de erro do banco:** CHECK `23514`, UNIQUE `23505`, FK `23503`, triggers de imutabilidade `23001` (`restrict_violation`), divergência saldo × ledger `23514`.

**TRUNCATE não é bloqueado:** triggers de linha não disparam em TRUNCATE, que é operação administrativa (os testes limpam com ele). Em produção, o usuário da aplicação não deve ter permissão de `TRUNCATE`.

## Estratégia transacional

**Regra:** cada efeito de negócio é **uma** transação SQL (READ COMMITTED) aberta pela porta `WagerUnitOfWork` (adaptador `MikroOrmWagerUnitOfWork`, sobre `em.transactional()` num `em.fork()` próprio). O que ela grava entra no mesmo commit, ou nada entra.

| Entrada | Grava no mesmo commit |
|---|---|
| `ProcessWagerTransaction` (HTTP e SQS) | transação, saldo (com `version`), lançamento, eventos na outbox e, pela fila, a linha da inbox; o caminho rápido das pendentes da mesma wallet |
| `OpenWallet` (`POST /wallets`) | wallet (version 1), transação `OPENING`, lançamento CREDIT e `WalletBalanceChanged` |
| Worker de pendentes | resolução da pendente, saldo, lançamento, eventos e caminho rápido |
| Outbox publisher | marcação de publicado e backoff dos eventos do lote (o envio ao SQS acontece dentro da transação, com o lock; ver [Outbox publisher](#outbox-publisher)) |

- **Eventos só saem pelo publisher**, depois do commit. Nenhum caminho publica no SQS de dentro do use case.
- **Ack do SQS só depois do commit:** o `DeleteMessage` acontece quando o use case retorna.
- **O domínio decide, o banco confirma:** o use case aplica as regras no domínio e grava o resultado. As FKs deferidas e o trigger saldo × ledger são checados no COMMIT; qualquer violação desfaz tudo.
- **Tradução de erros:** o adaptador traduz SQLSTATE em resultados do use case. `55P03` (lock timeout), `40P01` (deadlock), `40001` (serialização), pool esgotado ou banco fora viram `TransientFailure`; `23505` só nas constraints de idempotência e inbox vira replay ou conflito (ver [Idempotência](#idempotência)); `23505` em qualquer outra constraint, e os demais erros, são bugs e são relançados.
- **Prova:** `test/integration/application/atomicity.test.ts` cria um trigger real que derruba uma gravação no meio do commit (no use case e na resolução pelo worker): nada persiste, e o reenvio aplica uma vez.

## Concorrência

**Escolha:** lock pessimista por wallet. `SELECT ... FOR UPDATE` na linha da wallet, dentro da transação do use case, com `SET LOCAL lock_timeout = '2000ms'`. O `UPDATE` da wallet ainda confere a `version` como segunda barreira.

**Por que pessimista, e não otimista com retry:**
- O caso dominante é contenção na **mesma** wallet: rodadas rápidas, reentregas at-least-once, várias instâncias. Com lock otimista, cada conflito vira rollback e reexecução inteira. Com pessimista, a segunda transação espera alguns milissegundos e roda sobre o estado já commitado.
- A checagem de idempotência fica **sob o lock**. A transação original, se existir, foi gravada por quem segurava o mesmo lock e já está visível (READ COMMITTED lê a cada statement). Assim, "a mesma BET 50x em paralelo" vira 1 processamento e 49 replays, sem depender de violação de unicidade.
- Uma conexão fica ocupada esperando o lock; por isso o `lock_timeout` é curto. Esgotado, a transação aborta (`55P03`) e o resultado é `TransientFailure('lock_timeout')`: o provedor reenvia a mesma requisição, que é idempotente.

**Granularidade:** só a linha da wallet é travada; wallets diferentes não se bloqueiam. Não há lock global, advisory lock nem tabela de controle. O lock usa `WHERE id = $wallet AND player_id = $player`, então quem não é dono da wallet não segura nem espera o lock dela. Uma leitura sem lock distingue `WALLET_NOT_FOUND` de `WALLET_PLAYER_MISMATCH`.

**Segunda barreira (version):** `UPDATE wallets SET balance, version = v+1, updated_at WHERE id = $w AND version = $v`. Com o `FOR UPDATE`, ela nunca deveria falhar. Se falhar (bug, ou escrita fora do use case), a transação faz rollback e o resultado é `TransientFailure('version_conflict')`, com log `wallet_lock_conflict` e a métrica `wagering_lock_conflicts_total`. Lock timeout e deadlock também são contados.

**Ausência de deadlock:** cada transação trava **uma única** linha de wallet, sempre antes de qualquer escrita, então não existe espera circular entre locks de linha. As outras esperas possíveis são de índices únicos (duas transações inserindo a mesma key em wallets diferentes); como todas inserem nos mesmos índices e na mesma ordem, a espera é sempre num sentido só. Se ainda assim o Postgres detectar deadlock (`40P01`) ou falha de serialização (`40001`), o resultado é `TransientFailure`. Os workers seguem a mesma ordem (wallet primeiro; ver [Worker de referências pendentes](#worker-de-referências-pendentes)).

**SQL dentro da transação:**
1. `BEGIN; SET LOCAL lock_timeout = '2000ms'`
2. `SELECT * FROM wallets WHERE id = $w AND player_id = $p FOR UPDATE`
3. `SELECT * FROM wager_transactions WHERE provider_id = $p AND (idempotency_key = $k OR external_transaction_id = $e)`. Se achar, é replay ou conflito, e termina aqui (no replay, só a inbox é gravada).
4. Se a wallet não veio: `SELECT count(*) FROM wallets WHERE id = $w` (sem lock).
5. Se há referência: `SELECT * FROM wager_transactions WHERE provider_id = $p AND external_transaction_id = $ref` e depois `SELECT count(*) … WHERE reference_transaction_id = $id AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`.
6. `INSERT wager_transactions`, já no status final (PROCESSED, REJECTED ou PENDING_REFERENCE).
7. Se o saldo mudou: `UPDATE wallets … WHERE id = $w AND version = $v` e `INSERT wallet_ledger_entries`.
8. `INSERT outbox_messages` (1 ou 2 eventos) e, com contexto de inbox, `INSERT inbox_messages`.
9. `COMMIT`. As FKs deferidas e o trigger saldo × ledger são checados aqui.

**Comprovação:** `test/concurrency/process-wager-transaction.test.ts` usa 3 instâncias de MikroORM (pools separados) com `Promise.all`: 80+80 sobre saldo 100 (uma PROCESSED, uma `INSUFFICIENT_BALANCE`, saldo 20, um débito); a mesma BET 50x (1 débito, 1 linha, 49 replays); 30 BETs disputando o saldo; a mesma key em wallets diferentes; e, com uma transação do use case parada no lock da wallet A, 12 outras wallets processadas em paralelo (sem lock global). Falhas transitórias são reenviadas idênticas, com backoff curto, como faria um provedor. O caminho `23505 → conflito` tem um teste determinístico, em que uma transação externa segura o INSERT. Entre processos reais, ver [Estratégia de testes](#estratégia-de-testes).

## Idempotência

A garantia é o banco, nunca a memória.

### Fluxo

1. **Antes da transação:** validação completa (`InvalidInput` não grava nada) e cálculo do `payloadHash`.
2. **Sob o lock da wallet:** busca por `(provider_id, idempotency_key)` **ou** `(provider_id, external_transaction_id)`.
   - Mesma key **e** mesmo hash → **replay**. O resultado é reconstruído do estado persistido (`status`, `failure_code`, `observed_balance`) e é idêntico ao original, exceto por `idempotentReplay: true`. Vale para PROCESSED, REJECTED e PENDING_REFERENCE; esta última devolve o estado atual, que pode já ter sido resolvido pelo worker (com o `observed_balance` da resolução, não o saldo de agora).
   - Hash diferente, ou o mesmo `externalTransactionId` sob outra key → **conflito** (`IdempotencyConflict` com o id existente). Nada é gravado.
3. **Se o INSERT violar a unicidade mesmo assim** (por exemplo, a mesma key com outra `walletId`, que trava outra linha, ou a mesma mensagem SQS reentregue):
   - o adaptador só traduz `23505` nas constraints esperadas: `uq_wager_tx_provider_idempotency_key` e `uq_wager_tx_provider_external` viram `idempotency`, e `pk_inbox_messages` vira `inbox`;
   - depois do rollback, o use case relê numa transação nova e devolve replay ou conflito;
   - uma mensagem de inbox já usada por **outra** transação devolve `IdempotencyConflict` sem id, e não deve ser reenviada;
   - `23505` em qualquer outra constraint, ou de idempotência sem linha correspondente, é bug e é relançado.

**Escopo por provider:** a idempotency key é única por `(provider_id, idempotency_key)`. Com unicidade global, um provider poderia gravar antes a key de outro e bloquear a transação legítima dele, recebendo ainda o id interno dela no conflito. Isso pressupõe que `payload.providerId` seja o provider autenticado (ver [Autenticação](#autenticação)).

### Resultado do use case

União tipada; o mapeamento para HTTP está em [API HTTP](#api-http) e para SQS, em [Consumidor SQS](#consumidor-sqs).

| Variante | Significado |
|---|---|
| `Processed` | aplicada; traz `status` e saldo |
| `PendingReference` | aguardando a referência; traz `status` |
| `Rejected` | `status` REJECTED = regra de negócio; FAILED = falha permanente de infra |
| `IdempotencyConflict` | mesma key com outro payload, ou mensagem de inbox já usada |
| `InvalidInput` | código único `INVALID_INPUT`, motivo em texto |
| `TransientFailure` | `lock_timeout`, `deadlock`, `serialization`, `unavailable` ou `version_conflict`; sempre é seguro reenviar a mesma requisição |

Erros lançados fora da união são bugs (500, ou mensagem sem ack). Ids e textos têm limite de 256 caracteres (`InvalidInput`).

**`correlationId` e `causationId` dos eventos:** o `correlationId` vem da entrada. O `causationId` é o que originou o evento: nos eventos de transação, o `messageId` da inbox (SQS) ou a idempotency key (HTTP); no `WalletBalanceChanged`, o `eventId` do `WagerTransactionProcessed` que o causou.

### Algoritmo do `payloadHash`

`payloadHash = hex(SHA-256(utf8(JSON canônico)))`, em `src/application/wagering/payload-hash.ts`.

- **Campos (só de negócio):** `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money: { amount, currency }` e `referenceExternalTransactionId`. Ficam fora o header `Idempotency-Key`, o `correlationId` e os metadados de transporte.
- **Normalização:** `money.amount` passa pelo `Money` e sai sempre com 2 casas (`"25"` e `"25.00"` são o mesmo payload); `walletId` vai em minúsculas (é UUID); referência ausente entra como `null`.
- **Canônico:** chaves ordenadas por code unit, recursivamente, sem espaços, com strings escapadas como no `JSON.stringify`.

```json
{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a","referenceExternalTransactionId":null,"roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}
```

Mudar campos, normalização ou ordenação muda os hashes já gravados e transforma replays legítimos em conflitos. É mudança de contrato, e o teste `payload-hash.test.ts` fixa o JSON exato. O hash da **inbox** é outro (ver [Consumidor SQS](#consumidor-sqs)).

## Regras de negócio

As regras do CHALLENGE §7 são aplicadas por `WagerSettlement` (`src/application/wagering/wager-settlement.ts`), a fonte única de "resolver referência + aplicar regras + gravar", usada pelo use case (modo `insert`) e pelo worker de pendentes (modo `update`).

- **Uma reversão no total por transação.** O CHALLENGE §7.4 diz "não pode ser revertida duas vezes **pelo mesmo tipo**". Adotamos uma regra mais estrita, para nunca creditar duas vezes: uma BET recebe no máximo um `REFUND` **ou** um `ROLLBACK` PROCESSED, não os dois. Sem isso, BET 10 → REFUND +10 → ROLLBACK da BET +10 devolveria a aposta duas vezes. O índice `ux_wager_tx_one_reversal` garante isso no banco; o use case checa antes, sob o lock, e rejeita com `REFERENCE_ALREADY_REVERSED`.
- **ROLLBACK de REFUND** continua permitido e reverte o estorno, debitando. Ele referencia o REFUND, não a BET, então não conta como segunda reversão da BET.
- **WIN/LOSS sobre BET já estornada** → `REFERENCE_ALREADY_REVERSED`: liquidar uma aposta cujo valor já voltou ao jogador pagaria prêmio sobre uma aposta que não existe mais.
- **WIN e LOSS podem referenciar a BET** da rodada (é opcional). Quando referenciam, valem as mesmas validações da reversão, exceto valor igual: kind = BET, mesma wallet, player, rodada e moeda, status PROCESSED. Referência inexistente ou ainda pendente → `PENDING_REFERENCE`.
- **Valor:** reversões exigem valor igual ao da referência (`AMOUNT_MISMATCH`). Não há reversão parcial.
- **Auto-referência:** uma transação não referencia a si mesma, e BET não referencia nada (`InvalidInput`).
- **Saldo insuficiente na reversão** (por exemplo, ROLLBACK de um WIN já gasto) → `REVERSAL_WOULD_OVERDRAW`, distinto do `INSUFFICIENT_BALANCE` da BET e auditável.
- **Crédito além do limite do `numeric(20,2)`** → `BALANCE_LIMIT_EXCEEDED`, com a wallet intacta.
- **Referência pendente aguarda:** se a referência está `PENDING`/`PENDING_REFERENCE`, a transação também fica `PENDING_REFERENCE`. Só a referência `REJECTED`/`FAILED` gera `REFERENCE_NOT_PROCESSED`.

## Taxonomia de failureCode

Strings estáveis em `src/domain/failure-code.ts`. São contrato público: só se acrescenta, e renomear é breaking change (o teste `failure-code.test.ts` quebra). A coluna "Ação do provedor" diz o que fazer ao receber cada uma.

| Código | Quando | Ação do provedor |
|---|---|---|
| `INSUFFICIENT_BALANCE` | `BET` maior que o saldo | desistir (ou reenviar com outro valor, como nova transação) |
| `REVERSAL_WOULD_OVERDRAW` | `REFUND`/`ROLLBACK` deixaria o saldo negativo (ex.: rollback de um WIN já gasto) | tratamento operacional/manual |
| `WALLET_NOT_FOUND` | `walletId` inexistente | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | a wallet não pertence ao `playerId` informado | corrigir o payload |
| `CURRENCY_MISMATCH` | moeda da transação ≠ moeda da wallet ou da referência | corrigir o payload |
| `REFERENCE_NOT_FOUND` | prazo de `PENDING_REFERENCE` esgotado (TTL de 1h a partir do `createdAt`) sem a referência resolvida: ausente **ou** ainda pendente | reenviar a referência e depois a reversão, como novas transações |
| `REFERENCE_NOT_PROCESSED` | referência terminou `REJECTED` ou `FAILED` | desistir: não há o que reverter |
| `INVALID_REFERENCE_KIND` | `REFUND`, `WIN` ou `LOSS` que não referencia `BET`, ou `ROLLBACK` que não referencia `BET`/`WIN`/`REFUND` | corrigir o payload |
| `REFERENCE_ALREADY_REVERSED` | a referência já tem um `REFUND` ou `ROLLBACK` `PROCESSED`; vale também para `WIN`/`LOSS` sobre `BET` estornada | desistir (já aplicado) |
| `AMOUNT_MISMATCH` | valor da reversão ≠ valor da referência | corrigir o payload |
| `REFERENCE_ROUND_MISMATCH` | referência de outra rodada | corrigir o payload |
| `REFERENCE_PLAYER_MISMATCH` | referência de outro player | corrigir o payload |
| `REFERENCE_WALLET_MISMATCH` | referência de outra wallet | corrigir o payload |
| `INFRASTRUCTURE_FAILURE` | erro permanente de infraestrutura (status `FAILED`, auditável): pendente encerrada pelo worker após 5 erros inesperados seguidos | reenviar mais tarde, como nova transação |
| `BALANCE_LIMIT_EXCEEDED` | crédito que levaria o saldo além do limite do `numeric(20,2)` (18 dígitos inteiros) | tratamento operacional/manual |

- **Ordem de avaliação** (a primeira que falhar define o código): `WALLET_NOT_FOUND` → `WALLET_PLAYER_MISMATCH` → `CURRENCY_MISMATCH` → (se houver referência) ausente/pendente ⇒ `PENDING_REFERENCE` → `INVALID_REFERENCE_KIND` → `REFERENCE_WALLET_MISMATCH` → `REFERENCE_PLAYER_MISMATCH` → `REFERENCE_ROUND_MISMATCH` → `CURRENCY_MISMATCH` → `REFERENCE_NOT_PROCESSED` → `AMOUNT_MISMATCH` (só reversões) → `REFERENCE_ALREADY_REVERSED` → `INSUFFICIENT_BALANCE` / `REVERSAL_WOULD_OVERDRAW` / `BALANCE_LIMIT_EXCEEDED`.
- Não existe código de "referência de outro provider": a referência é resolvida por `(providerId, referenceExternalTransactionId)`, então outro provider resulta em `REFERENCE_NOT_FOUND`.
- A mesma idempotency key com payload diferente **não** é `failureCode`: é conflito de requisição (`409`) e não cria transação. Payload inválido também não (`400 INVALID_INPUT`).
- Rejeições no nível da wallet (`WALLET_*` e o `CURRENCY_MISMATCH` da wallet) **não** devolvem saldo, porque a wallet pode ser de outro jogador. As demais devolvem o saldo observado.
- Os erros de domínio (`InsufficientBalanceError`, `CurrencyMismatchError`…) não carregam `failureCode`, porque o mesmo erro pode significar códigos diferentes (um débito sem saldo é `INSUFFICIENT_BALANCE` numa BET e `REVERSAL_WOULD_OVERDRAW` num ROLLBACK de WIN). O `WagerSettlement` faz o mapeamento.

## API HTTP

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
- **503 é exclusivo de falha transitória.** `FAILED` é terminal: um 503 faria o provedor reenviar e receber o mesmo replay para sempre, por isso vai como 422 com `status: "FAILED"`. Erros transitórios lançados fora dos use cases (nas consultas) passam pelo mesmo `translatePersistenceError` e também viram 503.
- **422 não usa o envelope de erro:** é o resultado de uma transação gravada (tem `transactionId` e é replayável), com o mesmo formato do 200.
- **Replay** devolve o mesmo status do original e `idempotentReplay: true`.
- `Idempotency-Key` ausente ou só com espaços → 400. A validação do corpo é a do use case, que roda antes de abrir a transação: nada inválido é gravado.

### Abertura de wallet

- O use case `OpenWallet` grava, numa transação SQL, a wallet, a transação `OPENING`, o lançamento CREDIT e o `WalletBalanceChanged`. A OPENING é interna e **não** gera `WagerTransactionProcessed`. Saldo inicial zero não gera OPENING, lançamento nem evento.
- A duplicata é detectada pela constraint `uq_wallets_player_currency`. O 409 relê e devolve o `walletId` existente, para o cliente que perdeu a resposta do primeiro POST.
- `playerId` segue a regra de texto do use case (obrigatório, não vazio, até 256 caracteres).
- **Nomes reservados:** a OPENING usa `providerId = "internal"` e key e id externo `opening:<walletId>`. Providers externos não podem usar esse `providerId` nem keys com prefixo `opening:` (400), e `GET /providers/internal/...` também é 400. Sem isso, um cliente poderia ler as OPENINGs ou receber o id delas num 409.

### Consultas

`GET /wallets/:id`, `GET /wagering/transactions/:id` e `GET /providers/:providerId/wagering/transactions/:externalId`: 404 quando não existe, 400 quando o id não é UUID. Campos ausentes saem como `null`, nunca omitidos.

### Cursor do ledger

- `GET /wallets/:id/ledger?cursor=&limit=` devolve os lançamentos em ordem crescente de `seq` (identity). `limit` tem padrão 50 e teto 200; fora disso, 400.
- Cursor = base64url de `v1:<seq>` do último item da página. É opaco para o cliente, e o prefixo de versão permite trocar o formato sem quebrar cursores em circulação. Cursor vazio, malformado, fora da faixa de `bigint` ou repetido na query → 400.
- **Estável, sem pular nem repetir:** os lançamentos de uma wallet só são gravados sob o lock dela, então `seq` cresce na ordem de commit dentro da wallet. Uma inserção nova sempre fica depois de qualquer cursor já emitido.
- `nextCursor` é `null` na última página: a consulta busca `limit + 1` para saber se há mais.

### Reconciliação

- `POST /wallets/:id/reconciliation` lê o saldo e a soma do ledger (CREDIT − DEBIT) **num único statement**, então os dois vêm do mesmo snapshot.
- `difference = storedBalance − calculatedBalance`. `consistent` é `difference == 0.00`, e `checkedEntries` é o número de lançamentos somados.
- **Nunca corrige.** Na divergência: log `warn` `reconciliation_divergence` (com `walletId` e `correlationId`), incremento de `wagering_reconciliation_divergences_total` e `consistent: false` na resposta. Corrigir exige investigar a causa; um ajuste automático esconderia o bug que a gerou.
- Cobre o que o schema não garante: problemas no encadeamento de `balance_before` ou no valor do lançamento aparecem como divergência de soma.

## Autenticação

**Decisão:** não implementada. O CHALLENGE §2 diz que ela não vale pontos e não deve competir com correção financeira. O **ponto de extensão** é o `AuthGuard` (`src/interfaces/http/auth.guard.ts`, hoje no-op), aplicado a todo o `WageringController`. Health e `/metrics` ficam fora do guard.

**Desenho que seria adotado:**

- **IdP externo:** Keycloak (ou Zitadel), sem tabela própria de usuários.
- **Como o provider se autentica:** OAuth2 *client credentials*, um client por provider. O provider pede um access token (JWT) ao IdP e o envia em `Authorization: Bearer`. O `AuthGuard` valida assinatura (JWKS do IdP, em cache), `iss`, `aud` e `exp`, e coloca na requisição a identidade: `providerId` (claim do client) e os escopos.
- **Escopos:** `wagering:write` e `wagering:read` para providers; `wallets:read`, `wallets:write` e `wallets:reconcile` para o backoffice.
- **Amarração do `providerId` ao payload:** em `POST /wagering/transactions`, `payload.providerId` diferente do token → 403, antes do use case. Hoje o use case confia no `providerId` do payload.
- **Consultas de transação:** `GET /providers/:providerId/...` só para o próprio provider (outro → 404, para não revelar existência); `GET /wagering/transactions/:id` filtrado pelo provider do token (transação alheia → 404). O backoffice com `wallets:read` vê tudo.
- **Vínculo wallet ↔ provider** (não existe hoje): uma tabela `wallet_providers (wallet_id, provider_id)` com PK composta, criada por migration nova.
  - `POST /wallets` chamado por um provider (escopo `wallets:write`) cria a wallet **e** o vínculo com o provider do token, na mesma transação SQL. Pelo backoffice, o `providerId` é informado no corpo.
  - Um segundo provider só ganha acesso à mesma wallet por uma operação de backoffice que insere o vínculo. Uma tabela, e não uma coluna `wallets.provider_id`, porque o mesmo jogador pode jogar em vários provedores com a mesma wallet.
  - `POST /wagering/transactions` passa a exigir o vínculo: a leitura da wallet sob lock ganha `AND EXISTS (wallet_providers …)`. Sem vínculo, o resultado é `WALLET_NOT_FOUND`, sem revelar que a wallet existe.
- **Quem lê `GET /wallets/:id` e `GET /wallets/:id/ledger`:** um provider vinculado à wallet (escopo `wagering:read`) ou o backoffice (`wallets:read`). Qualquer outro → 404. A reconciliação exige `wallets:reconcile` (só backoffice).
- **SQS:** continua como canal interno confiável (CHALLENGE §2). Quem publica na fila é um serviço interno que já autenticou o provider; a mensagem passa pelas mesmas validações de domínio, inclusive o vínculo wallet ↔ provider quando ele existir.

**Consequência de não implementar:** qualquer cliente que alcance a API submete em nome de qualquer provider e lê transações, saldos e ledgers. É aceitável só em ambiente de avaliação (ver [limitações](#decisões-trade-offs-e-limitações)).

## Consumidor SQS

`src/interfaces/sqs/wager-consumer.ts`, ligado por `SQS_CONSUMER_ENABLED` (default `true`; `false` no `.env.test`). Cliente da fila em `src/infrastructure/sqs/`.

### Fluxo por mensagem

1. **Receive** com long polling: `WaitTimeSeconds=20`, `MaxNumberOfMessages=10`, `VisibilityTimeout=60`. Pede `ApproximateReceiveCount` e `MessageGroupId`.
2. **Envelope** (`wager-envelope.ts`): JSON, `messageId` (texto até 256), `type = WagerTransactionRequested`, `occurredAt` ISO 8601 com fuso, `data` objeto, `data.idempotencyKey` obrigatório. Os campos de negócio de `data` são validados pelo próprio use case, o mesmo validador da entrada HTTP; por isso `kind=OPENING` e `providerId=internal` são `InvalidInput`.
3. **`payloadHash` da inbox:** SHA-256 hex do JSON canônico de `{ type, data }`. Ficam fora `messageId`, `occurredAt`, `correlationId` e outros metadados. É diferente do `payloadHash` da transação: o da inbox identifica a **mensagem** (inclui a `idempotencyKey` e não normaliza `"25"` × `"25.00"`).
4. **Pré-checagem da inbox** `(consumerName, messageId)`, fora da transação. Se já existe: mesmo hash → ack sem chamar o use case (conta como replay); hash diferente → DLQ. É só o caminho rápido; a garantia é a PK da inbox, gravada **na mesma transação** do efeito.
5. **Use case** via `InstrumentedProcessWagerTransaction` (mesmas métricas do HTTP), com `inbox = { consumerName, messageId, payloadHash }` e `correlationId` = o do envelope, se válido, senão o `messageId`.
6. **Ação**, conforme a classificação abaixo. O ack (`DeleteMessage`) só acontece depois que o use case retorna, ou seja, depois do commit. Se o `DeleteMessage` falhar, a reentrega cai na pré-checagem da inbox e é confirmada sem efeito novo (testado).

### Classificação

| Resultado / erro | Ação |
|---|---|
| `Processed`, `Rejected` (REJECTED e FAILED), `PendingReference`, inclusive replay | ack |
| Inbox com a mesma mensagem e o mesmo hash (pré-checagem ou releitura) | ack, `wagering_idempotent_replays_total` |
| `IdempotencyConflict` com `existingTransactionId` e sem linha na inbox | ack + log `warn` (`wagering_idempotency_conflicts_total`) |
| `IdempotencyConflict` sem id (corrida na PK da inbox) | relê a inbox: mesmo hash → ack; outro hash → DLQ `INBOX_PAYLOAD_MISMATCH`; sem linha → retry |
| Inbox com o mesmo `messageId` e outro hash | DLQ `INBOX_PAYLOAD_MISMATCH` |
| Corpo não-JSON, envelope inválido ou ilegível | DLQ `INVALID_ENVELOPE` |
| `InvalidInput` | DLQ `INVALID_PAYLOAD` (motivo em `dlqDetail`) |
| `TransientFailure`, falha transitória na pré-checagem, exceção inesperada (bug) | retry: `ChangeMessageVisibility` com backoff + `wagering_retries_total`; na 5ª tentativa → DLQ `MAX_ATTEMPTS_EXCEEDED` |

- **DLQ:** primeiro `SendMessage` na `wager-transactions-dlq.fifo`, depois `DeleteMessage` na principal. Atributos: `dlqReason` (um dos 4 códigos acima), `dlqDetail` (até 256 caracteres, sem valores do payload), `sourceMessageId` e `receiveCount`. O `MessageGroupId` é o original, e o `MessageDeduplicationId` é o MessageId do SQS: se o delete falhar, a reentrega reenvia para a DLQ e o broker deduplica (testado). Conta em `wagering_dlq_messages_total`.
- **Erro inesperado** é tratado como transitório até o limite: um bug não descarta a mensagem na primeira falha, e ela acaba na DLQ com motivo, para análise.
- **Recuperação:** redrive manual da DLQ para a fila principal. É seguro: a inbox e a idempotência impedem efeito duplicado.

### Números

| Parâmetro | Valor | Motivo |
|---|---|---|
| Limite do consumidor (`SQS_CONSUMER_MAX_ATTEMPTS`) | 5 | DLQ com motivo e métrica, decidida pelo consumidor |
| `maxReceiveCount` da fila | 10 | rede de segurança (abaixo) |
| Backoff do retry | `30s·2^(n−1)`, teto 300s: 30/60/120/240 | `n` = `ApproximateReceiveCount` |
| `VisibilityTimeout` no receive | 60s | pior caso de um lote: 10 mensagens do mesmo grupo em sequência × ~5s (`lock_timeout` 2s + releitura) |
| `WaitTimeSeconds` | 20 | long polling: menos chamadas vazias |
| Pausa do polling (banco ou SQS fora) | `1s·2^(n−1)`, até 30s | não drenar a fila contra um banco fora do ar |
| `SQS_SHUTDOWN_TIMEOUT_MS` | 8s | um dos três prazos de shutdown, que rodam em sequência (ver [Estratégia de testes](#estratégia-de-testes)) |

**Tolerância a falha transitória:** uma mensagem tem 5 tentativas, separadas por 30+60+120+240 = 450s, ou seja, **~7,5 min** desde o primeiro recebimento até a DLQ. Quando a falha é `unavailable` (banco fora, pool esgotado) ou o próprio SQS falha, o loop também pausa o polling (1s, 2s, 4s… até 30s, zerando no primeiro lote sem falha de conexão). Assim a instância não sai recebendo e queimando tentativas de mensagens novas enquanto o banco está fora; as mensagens já recebidas seguem o backoff normal.

**Por que 5 no consumidor e 10 na fila:** o SQS incrementa o `ApproximateReceiveCount` a cada **recebimento**, mesmo sem processamento. As mensagens que esperam atrás de uma que falhou no mesmo grupo são recebidas de novo a cada ciclo, e a contagem delas sobe junto (o mesmo vale para mensagens devolvidas no shutdown). Com redrive em 5, a fila mandaria essas mensagens válidas, nunca tentadas, para a DLQ sem motivo nem métrica. Com 5 no consumidor e 10 na fila:
- a mensagem que falha vai para a DLQ pelo consumidor, com motivo, na 5ª tentativa, e as seguintes do grupo são processadas em seguida, no mesmo lote (testado);
- o redrive nativo só age se o consumidor não conseguir decidir (por exemplo, falhas repetidas do próprio SQS).

### FIFO é otimização, não garantia

- `MessageGroupId = walletId` e `MessageDeduplicationId = messageId` vêm do produtor. A dedup do broker vale só por 5 minutos e só para o mesmo dedup id, e a ordem por grupo não protege contra reentrega, outro produtor, redrive manual ou várias instâncias. A correção vem do banco: inbox, idempotência e lock por wallet (CHALLENGE §5.3).
- Mesmo assim, o consumidor preserva a ordem do grupo, porque ela reduz `PENDING_REFERENCE` (ROLLBACK antes da BET):
  - grupos diferentes do lote rodam em paralelo; o mesmo grupo, em sequência;
  - se uma mensagem vai para retry, as seguintes do grupo recebem **a mesma visibilidade** e voltam junto, atrás dela. Não se depende de o broker bloquear o grupo enquanto há mensagem em voo: o LocalStack não bloqueia, e um teste com BET + ROLLBACK falhava ao liberar as seguintes com visibilidade 0;
  - se a própria ação no SQS falhar (`ChangeMessageVisibility`, envio à DLQ), o grupo para, e as seguintes ficam em voo até expirar, junto com a que falhou.

### Shutdown (`SIGTERM`)

`WagerConsumerModule.beforeApplicationShutdown`, que roda antes de o ORM e o cliente SQS fecharem (`onApplicationShutdown`):
1. para de buscar, acorda uma pausa em andamento e **aborta o `ReceiveMessage` em andamento** (`abortSignal` do SDK), para que o long polling de até 20s não consuma o prazo de 8s;
2. espera o lote atual até `SQS_SHUTDOWN_TIMEOUT_MS`;
3. no timeout, `ChangeMessageVisibility 0` em tudo o que não terminou.

O processamento abandonado ainda pode commitar. A instância que pegar a mensagem cai na inbox ou na idempotência, e o resultado é um único efeito (testado). Um `start()` não abre um segundo loop enquanto o anterior não terminou. O vínculo sinal → hooks vem de `enableShutdownHooks()` em `main.ts`.

### Logs

`sqs_message_acked`, `sqs_message_retry`, `sqs_message_dead_lettered`, `sqs_ack_failed`, `sqs_polling_paused`, entre outros, todos com `sqsMessageId`, `receiveCount`, `messageId`, `correlationId` e, quando houver, `transactionId`, `outcome` ou `reason`. Nunca entram `data`, valores nem o `dlqDetail`. `sqs_message_acked` só é emitido **depois** do `DeleteMessage` bem-sucedido; se o delete falha, sai só `sqs_ack_failed`, e a reentrega aparece depois como `sqs_message_acked` com `DUPLICATE_MESSAGE` (testado). Contar acks pelo log conta acks reais.

## Outbox publisher

`src/interfaces/workers/outbox-publisher.ts`, ligado por `OUTBOX_PUBLISHER_ENABLED` (default `true`; `false` no `.env.test`). SQL em `src/infrastructure/outbox/outbox-store.ts` e envio em `outbox-events.client.ts`. Destino: `wager-events.fifo`.

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
- **`$now` vem do `Clock` injetado**, não do `now()` do banco, para que os testes avancem o tempo e confiram o backoff pelos valores gravados.
- **O `update` exige `published_at is null`** e confere `affectedRows = 1`. Sob o lock, isso nunca falha; se falhar, é bug, e o lote inteiro sofre rollback (testado).

### At-least-once e contrato de dedup

- O evento só é marcado como publicado **no mesmo commit** em que o envio foi aceito. Se o processo morre entre o envio e o commit, o evento continua pendente e é republicado, por esta ou outra instância, **com o mesmo `eventId`** (testado com exceção e com `pg_terminate_backend`). Nunca acontece o contrário: um evento marcado sem ter sido aceito pelo broker.
- **Contrato para quem consome `wager-events.fifo`:** o corpo é exatamente o `toJSON()` gravado em `outbox_messages.payload` (CHALLENGE §11); `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId`; **o consumidor deve deduplicar por `eventId`, de forma persistente** (por exemplo, com uma inbox como a do [Consumidor SQS](#consumidor-sqs)). A dedup do broker (5 min, mesmo dedup id) é só otimização.

### Ordem por agregado

- `seq bigint generated always as identity` é atribuído no INSERT. Os eventos de uma wallet são inseridos **sob o lock da wallet**, então, dentro de um agregado, ordem de `seq` = ordem de commit.
- **Regra:** só é elegível o pendente de **menor `seq`** do agregado (o `not exists` do claim, servido por `ix_outbox_pending_aggregate`). Um evento anterior travado por outro publisher, em backoff ou falhando bloqueia os seguintes do agregado; por isso dois publishers nunca publicam o mesmo agregado fora de ordem (testado). Uma leitura defasada do `not exists` só erra para o lado seguro: um evento publicado nunca volta a pendente.
- **`aggregateId`:** `WalletBalanceChanged` usa `wallet.id` e carrega `walletVersion` (o consumidor pode descartar versões menores ou iguais à última aplicada). Os eventos de transação usam `tx.id`: ficam ordenados por transação (ex.: PendingReference → Processed), não entre transações da mesma wallet.
- **Backfill na migration `…400000_outbox_seq`:** com `add column … generated as identity`, as linhas existentes seriam numeradas na ordem física do heap; por isso a migration numera por `(occurred_at, id)`, depois transforma a coluna em identity e ajusta a sequência (testado).
- **Vazão:** no máximo **um evento por agregado por ciclo**, porque o 2º só fica elegível depois do commit do 1º. Lotes com agregados diferentes saem juntos; uma rajada de uma mesma wallet publica um evento por round-trip (alguns ms localmente). O teste com 50 `WalletBalanceChanged` de uma wallet confere a ordem e a ausência de espera entre eles.

### Falha: backoff sem descarte

| Situação | Ação |
|---|---|
| Entrada recusada no `SendMessageBatch` (`Failed`) | só ela vai para `scheduleRetry` (testado com recusa real do LocalStack, `InvalidMessageContents`) |
| Entrada sem resposta (nem `Successful` nem `Failed`) | tratada como falha, nunca como publicada |
| Chamada inteira falha (rede, timeout, 5xx, fila inexistente) | `scheduleRetry` do lote todo |
| Chamada inteira recusada por erro do cliente (`$fault = client`, 4xx) | reenvia **uma a uma**, dentro do mesmo prazo: uma entrada "venenosa" não prende os outros agregados do lote |
| Falha do próprio ciclo (banco fora) | rollback; o loop pausa `1s·2^(n−1)`, até 30s |

- **Backoff:** `1s·2^(attempts−1)`, teto de 5 min, gravado no mesmo commit.
- **Nunca há descarte nem DLQ para a outbox:** um evento confirmado não pode ser perdido (CHALLENGE §3), e uma DLQ quebraria a ordem do agregado.
- A partir de `OUTBOX_STUCK_ATTEMPTS` tentativas (10, ~8,5 min acumulados), cada nova falha gera um log `error` `outbox_event_stuck` (com `eventId`, `aggregateId`, `eventType`, `attempts`, `nextAttemptAt` e `code`), e o evento passa a contar no gauge `wagering_outbox_stuck_events`.

**Procedimento operacional para evento travado:**
1. **Alertas:** `wagering_outbox_stuck_events > 0` (ou o log `outbox_event_stuck`) e `wagering_outbox_lag_seconds` acima do SLO.
2. **Diagnóstico** pelo `code` do log: `InvalidMessageContents`/`InvalidParameterValue` = payload inválido (bug no produtor do evento); `batch_failed`, timeout ou rede = infraestrutura (SQS, rede, IAM).
3. **Infraestrutura:** basta corrigir a causa; o evento sai sozinho no próximo `next_attempt_at` (no máximo 5 min), e os seguintes do agregado vão atrás, em ordem.
4. **Payload inválido:** corrigir o código e reprocessar. Nunca apagar a linha nem marcá-la como publicada à mão sem decidir o que o consumidor deve receber. Para antecipar a tentativa: `update outbox_messages set next_attempt_at = null where id = $eventId`.

### Timeouts: um SQS lento não segura locks

| Parâmetro | Default | Motivo |
|---|---|---|
| `OUTBOX_SQS_TIMEOUT_MS` | 3s | `AbortSignal.timeout` em `GetQueueUrl` e `SendMessageBatch` (testado: o sinal chega ao SDK real) |
| SDK do publisher | `maxAttempts: 1` | cliente SQS próprio (`OUTBOX_SQS_CLIENT`), porque o `abortSignal` não interrompe a espera entre retries internos do SDK; o retry fica com a outbox |
| `OUTBOX_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 15s | se o processo travar com o lock, o Postgres derruba a sessão e solta o lock (testado com 1s) |
| `statement_timeout` | 5s | limita o claim e os updates |
| Regra validada no boot | `sqs + 2000 ≤ idle` | a folga cobre o save e o commit depois do envio |

### Loop, lag e shutdown

- Se o claim trouxe algum evento (publicado ou reagendado), busca de novo **na hora**. Espera `OUTBOX_POLL_INTERVAL_MS` (500ms) **só quando o claim volta vazio**. Com o SQS fora, todos os pendentes entram em backoff, o claim volta vazio e o loop passa a esperar: não há laço quente.
- **`wagering_outbox_lag_seconds`** = agora − `occurred_at` do pendente mais antigo (0 sem pendentes), medido a cada ciclo vazio e, sob carga, no máximo uma vez por intervalo. Inclui eventos em backoff e os bloqueados atrás de um evento travado: é o atraso real visto pelo consumidor.
- **Shutdown** (`OutboxPublisherModule.beforeApplicationShutdown`, antes de o ORM e os clientes SQS fecharem): para de buscar e acorda a espera do intervalo (testado: `stop()` volta na hora, mesmo com intervalo de 60s); espera o lote em andamento commitar até `OUTBOX_SHUTDOWN_TIMEOUT_MS` (8s). Se o prazo estourar, loga `outbox_publisher_shutdown_timeout` e segue; o lote abandonado não commita, a sessão cai e outra instância republica (testado).

## Worker de referências pendentes

Transações que chegam antes da referência (ROLLBACK/REFUND antes da BET, WIN/LOSS antes da BET) ficam `PENDING_REFERENCE`. O `PendingReferenceWorker` (`src/interfaces/workers/pending-reference-worker.ts`, caso de uso `ResolvePendingReferences`) as reprocessa com **as mesmas regras** da entrada, via `WagerSettlement` em modo `update`.

### Fluxo

1. **Busca, sem lock**, numa transação curta (índice parcial `ix_wager_tx_reference_check_due`):
   ```sql
   select id, wallet_id, player_id from wager_transactions
   where status = 'PENDING_REFERENCE' and next_reference_check_at <= $now
   order by next_reference_check_at limit $batch   -- 10
   ```
2. **Por candidata**, uma transação SQL própria (com o `lock_timeout` de 2s):
   1. wallet com `FOR UPDATE SKIP LOCKED` (ocupada → pula, `skipped{wallet_busy}`);
   2. a transação com `FOR UPDATE`, relida;
   3. se não estiver mais `PENDING_REFERENCE` ou não estiver vencida → pula (`not_due`): outra instância já tratou;
   4. `WagerSettlement.settle(..., 'update')`: `UPDATE ... WHERE id = ? AND status = 'PENDING_REFERENCE'` (0 linhas = bug, lança), saldo com `version`, ledger, outbox e caminho rápido, tudo no mesmo commit.
3. **Resultado:**
   - referência PROCESSED → regras normais, avaliadas **no momento da resolução**: PROCESSED (lançamento, `observedBalance`, `WagerTransactionProcessed` + `WalletBalanceChanged`) ou REJECTED com o código da regra;
   - referência REJECTED/FAILED → `REFERENCE_NOT_PROCESSED`;
   - referência ausente ou ainda pendente → nova tentativa (`attempts++`, backoff), **sem evento**;
   - prazo esgotado → REJECTED `REFERENCE_NOT_FOUND` + `WagerTransactionRejected`, no mesmo commit.

### Ordem de locks

- Use case: wallet (`FOR UPDATE`) → INSERT da transação → UPDATE do caminho rápido (só pendentes **da mesma wallet**).
- Worker: wallet (`SKIP LOCKED`) → transação pendente (`FOR UPDATE`) → UPDATE da pendente → caminho rápido (mesma wallet).
- As duas ordens começam pela wallet, e nenhuma linha de outra wallet é travada: não há ciclo. O caminho rápido só roda quando a wallet foi travada; uma rejeição sem wallet do player (`WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH`) não antecipa nada, porque essa transação nunca serve de referência.
- Com `SKIP LOCKED` na wallet, o worker não fica esperando atrás do tráfego de entrada nem de outra instância. Testado: dois workers sobre as mesmas pendentes, e worker + use case em paralelo na mesma wallet → efeito único, sem deadlock.

### Backoff e TTL

| Item | Valor | Por quê |
|---|---|---|
| Backoff | `5s · 2^(n−1)`, teto 10min | o primeiro retry pega o caso comum (a referência atrasada segundos, em outra fila ou instância); o teto limita a latência quando a referência chega tarde |
| Expiração | **TTL de 1h a partir do `createdAt`** (`PENDING_REFERENCE_TTL_MS`) | abaixo |
| Clamp | próxima checagem = `min(now + backoff, createdAt + TTL)` | a última tentativa cai exatamente no prazo (~13 tentativas em 1h) |
| Critério | `now >= createdAt + TTL` e a referência ainda não resolvida | |

Por que **TTL, e não número de tentativas**:
- o caminho rápido e as referências encadeadas consomem tentativas de forma imprevisível; um limite por contagem expiraria cedo justamente as cadeias que estão andando;
- o TTL é tempo de relógio e não depende de o worker ter ficado parado (um worker que volta depois do prazo expira na primeira checagem, mas ainda resolve se a referência já estiver PROCESSED);
- 1h folga bem sobre a janela de retry do SQS (~7,5 min até a DLQ) e do HTTP; depois disso, a referência só viria de reprocessamento manual, e o provedor precisa de uma resposta.

O TTL vale também para o use case: o primeiro agendamento já respeita o clamp, porque o `WagerSettlement` recebe `ttlMs` da config nos dois caminhos.

### Caminho rápido

Quando uma transação vira terminal (pelo use case **ou** pelo worker), na mesma transação SQL:
```sql
update wager_transactions set next_reference_check_at = $now
where status = 'PENDING_REFERENCE' and provider_id = $p and reference_external_transaction_id = $ext
  and wallet_id = $w and next_reference_check_at > $now
```
- Só reduz latência: quem resolve continua sendo o worker, sob as regras normais. Não conta tentativa.
- `wallet_id = $w` mantém o UPDATE dentro da wallet travada.
- Disparado também pelo worker: resolver um REFUND antecipa o ROLLBACK que espera por ele, então cadeias resolvem em ciclos seguidos, não no backoff.
- O trigger de guarda permite: o status não é terminal e nenhuma coluna de identidade muda (testado).

### `correlationId` e `causationId` na resolução

- A coluna `correlation_id` (migration `…500000_correlation_id`) é gravada no INSERT pelo use case e pela abertura de wallet e é **imutável** (entra na tupla do trigger de guarda).
- Eventos da resolução: `correlationId` = `correlation_id` da transação (fallback para linhas anteriores à coluna: o `id` da transação). `causationId` = `eventId` do `WagerTransactionPendingReference` da transação (fallback: o `id` da transação). O `WalletBalanceChanged` continua causado pelo `WagerTransactionProcessed`.

### Erros e heurísticas por candidata

- **Falha transitória** (lock timeout, deadlock, version, banco fora): `skipped{transient}`; a candidata continua vencida e volta no ciclo seguinte.
- **Erro inesperado** (bug, dado inconsistente): log `pending_reference_error` (só ids) e `skipped{error}`, **que é o alerta**. Depois de **5 erros inesperados seguidos** da mesma candidata, o worker a encerra como **FAILED `INFRASTRUCTURE_FAILURE`** numa transação nova (lock da wallet com espera → lock da transação → ainda pendente? → `fail` + `WagerTransactionRejected` + caminho rápido), com `wagering_pending_reference_failed_total`. Falhas transitórias não contam nem zeram o contador; um sucesso zera.
- **Wallet muito ativa:** depois de **5 `wallet_busy` seguidos** da mesma candidata, a próxima tentativa espera o lock da wallet (`FOR UPDATE` com o `lock_timeout` de 2s) em vez de pular, para não adiar para sempre.
- Os dois contadores ficam **em memória, por instância**: são **heurística operacional, não garantia**, com teto de 10 mil entradas. A correção não depende deles: as decisões são tomadas sob lock, com releitura e UPDATE condicionado ao status.

### Loop e shutdown

Mesmo padrão do outbox publisher: `start`/`stop` no módulo, `stop` em `beforeApplicationShutdown`, e erro do ciclo inteiro (banco fora) → pausa `1s·2^(n−1)` até 30s. Espera `PENDING_REFERENCE_POLL_INTERVAL_MS` só quando o lote vem vazio **ou nenhuma candidata avançou** (sem laço quente com wallet ocupada ou bug). No shutdown, para **entre candidatas**, e a candidata em andamento commita (testado). Prazo estourado: loga `pending_reference_worker_shutdown_timeout`; a transação abandonada sofre rollback quando o pool fecha, e outra instância a reprocessa.

## Observabilidade

### Health checks

Abertos, sem autenticação (CHALLENGE §2).

- **`GET /health/live`:** sempre `200 {"status":"alive"}` enquanto o processo responde. **Não** consulta dependências: uma queda do Postgres não deve fazer o orquestrador reiniciar todas as instâncias, o que só pioraria a recuperação.
- **`GET /health/ready`:** executa em paralelo os `ReadinessCheck` registrados, cada um com timeout próprio (`HEALTH_CHECK_TIMEOUT_MS`, 2s). `postgres` faz `select 1` com timeout e cancelamento no servidor (a conexão volta ao pool); `sqs` faz `GetQueueUrl` da fila principal e da DLQ, com `abortSignal`.

```json
// 200
{ "status": "ready", "dependencies": { "postgres": { "status": "up" }, "sqs": { "status": "up" } } }
// 503
{ "status": "not_ready", "dependencies": { "postgres": { "status": "down", "reason": "unreachable" }, "sqs": { "status": "up" } } }
```

- `reason` é um **conjunto fechado**: `timeout`, `unreachable` (falha de rede ou conexão) ou `error` (qualquer outro, ex.: fila inexistente). A resposta **nunca** carrega mensagem de driver, host, porta ou stack; o detalhe (nome e código do erro) vai para o log.
- As chaves `postgres` e `sqs` vêm de `ReadinessCheck.name` e são contrato público.
- **Porta própria** (`ReadinessCheck` + `ReadinessService`) em vez de `@nestjs/terminus`: dois checks não justificam a dependência, e a lógica (timeout, classificação) fica testável sem framework.

### Logs

- JSON (pino), uma linha por evento, a partir de um logger raiz (`src/infrastructure/observability/logger.ts`). O logger do Nest (boot, erros do framework) usa o mesmo JSON, via `PinoNestLogger`.
- **`correlationId`:** lido de `X-Correlation-Id` quando casa com `^[A-Za-z0-9._:-]{1,128}$`; caso contrário, é gerado um UUID. É sempre devolvido no header da resposta, inclusive em erros que acontecem antes do middleware (como JSON malformado), e propagado até o `correlationId` dos eventos da outbox.
- **Campos:** `correlationId`, `providerId`, `walletId` e `transactionId` quando existem; `messageId` e `sqsMessageId` nas entradas por SQS. O log de requisição usa o template da rota (`/wallets/:id`), não a URL.
- **Nunca entram nos logs:** payload financeiro completo, valores, mensagens do Postgres.

### Métricas

- `GET /metrics` (formato Prometheus), aberto como os health checks. Em produção ficaria numa porta interna ou atrás da rede do scraper.
- `InstrumentedProcessWagerTransaction` envolve o **use case**, não o controller, para que HTTP e consumidor SQS passem pelas mesmas métricas. Erros lançados também são medidos (`status="ERROR"`) e depois relançados.
- **Registry próprio** (`new Registry()` por `ObservabilityMetrics`), nunca o default do prom-client: duas aplicações no mesmo processo (como nos testes) não colidem.
- **Labels só de conjunto fechado:** `status`, `kind`, `failure_code`, `scope` e `reason`. Um `kind` fora do enum vira `UNKNOWN`, porque o valor cru vem do cliente e explodiria a cardinalidade. Ids nunca são labels.

| Métrica | Tipo | Labels | O que mede |
|---|---|---|---|
| `wagering_transactions_total` | counter | status, kind, failure_code | transações por status |
| `wagering_processing_duration_seconds` | histogram | status, kind, failure_code | latência do use case |
| `wagering_idempotent_replays_total` | counter | kind | duplicatas detectadas (HTTP e SQS) |
| `wagering_idempotency_conflicts_total` | counter | kind | mesma key com outro payload |
| `wagering_lock_conflicts_total` | counter | reason (`lock_timeout`, `deadlock`, `version_conflict`) | conflitos de lock da wallet; o log `wallet_lock_conflict` (pino) traz os mesmos campos |
| `wagering_reconciliation_divergences_total` | counter | — | reconciliações divergentes |
| `wagering_retries_total` | counter | — | cada `ChangeMessageVisibility` de retry no consumidor |
| `wagering_dlq_messages_total` | counter | — | mensagens enviadas à DLQ pelo consumidor (não conta o redrive nativo) |
| `wagering_outbox_lag_seconds` | gauge | — | agora − `occurred_at` do pendente mais antigo |
| `wagering_outbox_published_total` | counter | — | eventos publicados e commitados |
| `wagering_outbox_publish_failures_total` | counter | scope (`batch`, `entry`) | chamada inteira falhou × entrada recusada |
| `wagering_outbox_retries_total` | counter | — | eventos reagendados com backoff |
| `wagering_outbox_stuck_events` | gauge | — | pendentes com `attempts >= OUTBOX_STUCK_ATTEMPTS` |
| `wagering_pending_references` | gauge | — | transações em PENDING_REFERENCE, a cada `PENDING_REFERENCE_GAUGE_INTERVAL_MS` |
| `wagering_pending_reference_resolved_total` | counter | status (`PROCESSED`, `REJECTED`) | resolvidas com a referência encontrada |
| `wagering_pending_reference_expired_total` | counter | — | prazo esgotado → `REFERENCE_NOT_FOUND` |
| `wagering_pending_reference_rescheduled_total` | counter | — | novas tentativas agendadas |
| `wagering_pending_reference_failed_total` | counter | — | encerradas como FAILED após erros inesperados seguidos |
| `wagering_pending_reference_skipped_total` | counter | reason (`wallet_busy`, `not_due`, `transient`, `error`) | candidatas puladas; `error` é o alerta de bug |

## Estratégia de testes

Postgres e LocalStack são **reais** em todas as suítes que não são de unidade. Nada mocka o banco nem a fila. Integração e concorrência rodam no banco `wagering_test` (`.env.test`, com `NODE_ENV=test`) e aplicam as migrations sozinhas. As filas são criadas com nome único por suíte e apagadas no fim.

### O que cada suíte prova

| Suíte | Comando | Prova | Tempo típico* |
|---|---|---|---|
| Unidade | `bun run test:unit` | `Money`, invariantes da `Wallet`, regras BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, payload divergente, máquina de estados, config (inclusive a recusa do `FAULT_INJECTION` fora de `NODE_ENV=test` e o orçamento de shutdown) | ~5s |
| Integração | `bun run test:integration` | migrations e constraints; **atomicidade** (trigger real que derruba uma gravação no meio do commit, no use case e no worker de pendentes: nada persiste, e o reenvio aplica uma vez); inbox e redelivery; retry e DLQ; worker morto depois do commit e antes do ack (no processo); publishers concorrentes; recuperação de sessão morta (`pg_terminate_backend`, idle timeout); shutdown gracioso, inclusive com long polling em andamento | ~1 min |
| Concorrência | `bun run test:concurrency` | paralelismo real num processo: 80+80 sobre 100; a mesma BET 50x → 1 débito; mesma key em wallets diferentes; esgotar o saldo sem ficar negativo; dois publishers sobre a mesma outbox; dois workers de pendentes, e worker + use case na mesma wallet | ~10s |
| Multi-instância | `bun run test:multi` | itens 1, 4, 5 e 8 do CHALLENGE §13 com **processos reais** (abaixo); e processo morto **antes** do commit (SIGKILL com a transação aberta num trigger de teste: nada persiste, a mensagem volta e é aplicada uma vez) | ~45s |
| Carga | `bun run test:load` | throughput, latência e efeitos colaterais (lock, retries, DLQ, outbox lag) com 3 processos reais, em 3 cenários × níveis de concorrência, e consistência completa ao fim de cada rodada (abaixo). Fora do `bun test` (só com `LOAD=1`) | ~10 min |
| Chaos | `bun run test:chaos` | §3 "PostgreSQL e SQS temporariamente indisponíveis" com 2 processos sob carga: Postgres **parado** (`docker compose stop`/`start`) → API 503 com `Retry-After`, consumidor em retry sem DLQ, tudo retoma; LocalStack **pausado** → eventos confirmados ficam na outbox até publicar, consumidor e publisher retomam sem perder nada. Verificação só por comportamento (retries > 0, DLQ vazia, consistência por SQL) | ~40s |

\* Máquina de desenvolvimento (Windows 11, Docker Desktop).

**Rastreabilidade:** cada exigência do `CHALLENGE.md` ligada ao teste que a prova, e o teste de mutação manual (8 mutações, todas pegas), em [`docs/RASTREABILIDADE.md`](docs/RASTREABILIDADE.md).

**Chaos fora do `bun test`:** a suíte só roda com `CHAOS=1` (o script define) porque derruba containers compartilhados. O Postgres é **parado**, não pausado: com pause, as conexões abertas ficam penduradas em vez de recusadas, e não daria para provar o 503 nem o retry pelo comportamento. O LocalStack é **pausado**, porque um stop apagaria as filas da suíte (não há persistência). Backoff, visibilidade e prazos curtos valem só para a suíte; a tolerância do consumidor (5 tentativas, 2/4/8/8s) cobre a queda de ~12s. O `afterAll` restaura os containers mesmo em falha.

**Invariante final:** `wallet.balance == saldo reconstruído pelo ledger`, verificado por `expectLedgerConsistent` nos testes que movem saldo (no `wagering-http`, por um `afterEach` sobre todas as wallets, exceto no teste que corrompe o saldo de propósito) e, no multi e na carga, por SQL sobre todas as wallets (`test/multi/consistency.ts`, compartilhado pelas duas suítes). No banco, o constraint trigger saldo × último lançamento também barra a divergência no commit.

### Multi-instância (`test/multi`)

- **Processos:** `Instance` sobe `bun src/main.ts` com `Bun.spawn`, cada um com PID, pool de conexões e memória próprios, rodando API, consumidor SQS, outbox publisher e worker de pendentes sobre o mesmo Postgres e o mesmo LocalStack. A saída do pino é lida continuamente e contada **por vida do processo**: `start()` zera os contadores, e linhas tardias de uma vida anterior só vão para a cauda de diagnóstico.
- **Roteiro:**
  1. **Item 5:** uma instância `F` com `FAULT_INJECTION=exit_after_commit_before_ack` processa um BET pelo SQS e se mata com SIGKILL depois do commit e antes do `DeleteMessage`. Fica provado por SQL (transação, lançamento, inbox e 3 eventos pendentes), pela mensagem ainda na fila e pela ausência de `sqs_message_acked` na `F`. Depois sobem A, B e C; a reentrega cai na inbox (`DUPLICATE_MESSAGE`), sem segundo débito.
  2. **Item 1 entre instâncias e canais:** a mesma aposta 50x em paralelo, 30 por HTTP (10 em cada instância) e 20 por SQS (messageIds e grupos distintos, para as entregas correrem em paralelo). Resultado: 1 transação, 1 débito, um único `transactionId`.
  3. **Item 4, carga mista:** cenário 80+80 em duas instâncias; *hot wallet* com 120 BETs de 10,00 sobre 1000,00 (metade por HTTP, em rodízio nas 3 instâncias; metade por SQS no mesmo grupo) → exatamente 100 aceitas e 20 rejeitadas; duplicatas SQS (mesmo messageId com dedup do broker distinto); 12 wallets aleatórias pela seed. O teste **falha** se alguma das 3 instâncias não tiver atendido HTTP e confirmado mensagens SQS.
  4. **Item 8:** SIGKILL das 3 instâncias no meio da carga, reinício nas mesmas portas, onda 2 (REFUND/ROLLBACK antes da referência por HTTP e SQS, referência que nunca chega, replays em cada instância). O teste **falha** se alguma instância não atender HTTP e SQS depois do reinício.
  5. **Quiescência** e verificações finais, todas por SQL: saldo == ledger e nenhum saldo negativo; uma linha por idempotency key e no máximo um lançamento por transação; nenhuma referência revertida duas vezes; lançamentos só em PROCESSED que move saldo, com valor igual ao da transação; toda transação terminal com exatamente um evento terminal do tipo certo, e todo lançamento com exatamente um `WalletBalanceChanged`; outbox toda publicada, todo `eventId` na fila de eventos e nada a mais; DLQ vazia e reconciliação HTTP consistente; saldos finais iguais aos calculados **pelo teste**, de forma independente. Algumas dessas verificações repetem garantias do schema de propósito: o teste não confia no schema para afirmar o resultado.
- **Por que o resultado não depende da ordem:** nas wallets aleatórias, a soma das 6 BETs pequenas cabe no saldo e as 2 grandes passam do saldo máximo possível; na hot wallet, o saldo comporta exatamente 100 BETs. Qualquer intercalação dá o mesmo resultado final.
- **Docker:** o profile `multi` do compose valida empacotamento e shutdown; a suíte usa processos locais, que permitem SIGKILL e leitura de log por instância. Validação manual em 2026-11-07: build e `migrate` com saída 0; 3 réplicas `healthy` com `/health/ready` 200 em 3000, 3001 e 3002; `StopTimeout=30` e `NODE_ENV=production` nas três; no `down`, cada réplica registrou `pending_reference_worker_stopped`, `outbox_publisher_stopped` e `sqs_consumer_stopped` (nessa ordem) e saiu com código 0, sem `shutdown_timeout`, em ~4s no total, com o long polling de 20s abortado.

### Teste de carga (`test/load`)

CHALLENGE §14, "Diferenciais opcionais". Esta seção descreve **como** se mede. Os números e a análise estão em `docs/CARGA.md`, e a execução bruta usada lá em `docs/carga/resultado.json`. As demais execuções vão para `test/load/results/`, fora do git. Sondas de diagnóstico (recursos, outbox por agregado, vazão da inbox, custo do claim, lote do LocalStack FIFO) ficam em `test/load/diagnostics/` e rodam à parte, fora do `bun test`.

- **Sistema sob teste:** as 3 `Instance` do harness do multi (API + consumidor + outbox publisher + worker de pendentes), sobre o Postgres e o LocalStack do compose, com filas próprias da suíte. As configs são as de produção, exceto o backoff de retry do consumidor (1–5s em vez de 30–300s), para um `lock_timeout` eventual não segurar a quiescência por minutos. `src/` não tem nada específico para carga.
- **Cenários:**
  - **wallet-disputada:** 1 wallet, BET/WIN 50/50, só HTTP. Mede o custo da serialização por wallet.
  - **muitas-wallets:** 300 wallets, BET/WIN/LOSS em wallet aleatória, só HTTP, em rodízio pelas 3 instâncias.
  - **misto:** 200 wallets; metade dos clientes por HTTP e metade como produtores SQS. Inclui 10% de reenvios duplicados (no HTTP com a mesma key; no SQS com o mesmo messageId e outro dedup do broker, ou com um messageId novo e a mesma key), 5% de REFUND/ROLLBACK enviados antes da BET referenciada (no SQS, no mesmo grupo FIFO) e 5% de BETs acima do saldo (422 esperado).
- **Rodada (cenário × nível):** começa com as tabelas **vazias** (TRUNCATE), para que o volume da rodada anterior não contamine a medição. As wallets são abertas fora da janela. Depois vêm o aquecimento (`LOAD_WARMUP_S`, padrão 10s, descartado) e a janela de medição (`LOAD_DURATION_S`, padrão 45s). Então a rodada espera a **quiescência** e roda as mesmas verificações de consistência do multi. A rodada falha se alguma verificação falhar, se aparecer uma resposta 4xx que não seja 422 ou se alguma instância não tiver atendido HTTP (e SQS, no misto).
- **Níveis:** `LOAD_LEVELS`, padrão `10,50` (~10 min medidos, sendo boa parte esperando a quiescência). `LOAD_LEVELS=10,50,100` é opcional e leva mais (~15 min estimados, não medido). `LOAD_SCENARIOS` filtra cenários; `LOAD_SEED` fixa a sequência de operações de cada cliente. A intercalação entre clientes não é determinística.
- **Geração:**
  - **Clientes HTTP:** laço fechado. Cada um envia, espera a resposta e envia de novo, em rodízio entre as instâncias. Um 503 ou uma falha de rede é reenviado com a mesma key (contrato do provedor) e conta como retry do cliente.
  - **Produtores SQS:** taxa fixa (`LOAD_SQS_RATE` mensagens/s por produtor, padrão 5), ou seja, chegada aberta.
- **Métricas:**
  - **Latência HTTP:** por tentativa, medida no cliente. Entram só as tentativas iniciadas na janela.
  - **Status:** 2xx, 422 (rejeição de negócio, separada por `failureCode`), outros 4xx e erro (5xx e rede).
  - **Throughput:** req/s pelo cliente; transações/s (`created_at` na janela) e processadas/s (`processed_at` na janela) pelo banco.
  - **Ponta a ponta da fila:** do início do `SendMessage` até `inbox_messages.processed_at`, ou seja, o commit do consumidor (uma reversão pendente conta até o `PENDING_REFERENCE`, não até a resolução).
  - **Contadores de /metrics:** delta das 3 instâncias, para lock conflicts por `reason`, retries, DLQ, replays, outbox e pendentes, tanto na janela quanto na rodada inteira.
  - **Amostragem a cada 1s:** outbox lag (`agora − min(occurred_at)` das não publicadas, por SQL) e profundidade da fila, com máximo e p95 na janela e máximo até a quiescência.
  - **Relógio:** todos os instantes vêm do relógio do host (a aplicação grava as datas pelo `Clock`, não por `now()` do Postgres), então não há diferença de relógio entre o host e o container.
- **Downstream:** 4 consumidores de fundo leem a fila de eventos durante a rodada. A verificação de outbox (todo `eventId` entregue, nada a mais) usa esse conjunto.
- **Ambiente registrado automaticamente:** CPU, RAM, SO, versões do Bun, do Docker (e CPUs e memória da VM), do Postgres (`max_connections`, `shared_buffers`, `synchronous_commit`) e do LocalStack; pool por instância, `lock_timeout`, envs das instâncias e commit.
- **Limitações conhecidas (valem para qualquer número):**
  - Gerador, 3 instâncias, Postgres e LocalStack disputam a mesma CPU, e o Docker Desktop no Windows acrescenta uma VM e a rede dela.
  - LocalStack não é SQS: latência e limites são outros.
  - Clientes em laço fechado sofrem de *coordinated omission*: com o sistema lento, eles enviam menos, e os percentis subestimam a espera de uma chegada aberta.
  - O harness lê e interpreta o log JSON de cada instância no processo do gerador, o que soma CPU ao gerador.
  - A janela de 45s não exercita efeitos de longo prazo (crescimento de índices, autovacuum, tabelas grandes), já que cada rodada começa vazia.

### Injeção de falha

- `FAULT_INJECTION=exit_after_commit_before_ack` é a única falha injetada no código de produção, no ponto exato entre o commit e o `DeleteMessage` do consumidor, e só para resultado `PROCESSED`.
- É aceita **só com `NODE_ENV=test`** (lista de permissão). Com `NODE_ENV` ausente, `production`, `staging` ou qualquer outro valor, o `loadConfig` recusa e a aplicação não sobe (teste unitário). A imagem Docker fixa `NODE_ENV=production`.
- As demais falhas são injetadas **de fora**: triggers reais do Postgres criados só dentro do teste, `pg_terminate_backend`, filas inexistentes, cliente SQS com falha programada (`SpyQueueClient`) e use case embrulhado que devolve transitório ou lança.

### Determinismo

- **Sem sleep como sincronização:** toda espera é `eventually(condição, prazo)` com mensagem do que se esperava, ou espera por evento (`/health/ready`, saída do processo, sessão bloqueada em `pg_stat_activity`). Sobram só o backoff do cliente HTTP e um intervalo de 300ms entre as duas leituras da quiescência, porque as contagens do SQS são aproximadas.
- **Seed:** `MULTI_SEED` (inteiro; valor inválido derruba o teste) fixa os valores e a divisão HTTP/SQS da carga. Ela é impressa no início e, na falha, junto com o passo e a cauda de log de todas as instâncias.
- **Relógio manual:** nos testes do worker de pendentes e da outbox, o tempo avança por `ManualClock`, e o ciclo roda via `runOnce()`.
- Processos filhos são mortos no `afterAll` e também no `exit` do `bun test`, mesmo se interrompido.

### Orçamento de shutdown

O Nest chama os `beforeApplicationShutdown` **módulo a módulo, em sequência**. Consumidor SQS, outbox publisher e worker de pendentes param um depois do outro, e o pior caso do shutdown é a **soma** dos três prazos.

**Regra:** `SQS_SHUTDOWN_TIMEOUT_MS + OUTBOX_SHUTDOWN_TIMEOUT_MS + PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS` (8s cada) `≤ SHUTDOWN_BUDGET_MS` (25s) `< stop_grace_period` (30s no compose). O `loadConfig` recusa a soma acima do orçamento, e a aplicação não sobe (teste unitário).

**Por que 8s bastam:** cada componente só espera o trabalho em andamento: no consumidor, o lote atual (o long poll é abortado); na outbox, um lote com envio limitado a 3s; no worker de pendentes, uma candidata com `lock_timeout` de 2s. Estourado o prazo, o efeito continua seguro: a mensagem volta (visibilidade 0), o lote da outbox sofre rollback e é republicado, e a candidata é reprocessada por outra instância.

## Configuração

Todas as variáveis são lidas e validadas por `loadConfig` (`src/infrastructure/config/app-config.ts`); os valores abaixo são os defaults (iguais aos do `.env.example`). O `.env.test` é completo por conta própria: `NODE_ENV=test`, banco `wagering_test`, os três loops desligados e o resto com os mesmos valores locais.

| Variável | Default | Uso |
|---|---|---|
| `NODE_ENV` | `development` | `test` libera `FAULT_INJECTION`; a imagem Docker usa `production` |
| `HTTP_PORT` | `3000` | porta da API |
| `DATABASE_URL` | — (obrigatória) | `postgres://` ou `postgresql://` |
| `AWS_REGION` | `us-east-1` | região do SQS |
| `AWS_ENDPOINT_URL` | — | endpoint do LocalStack; fora do ambiente local, remover e usar IAM |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | informadas juntas, ou nenhuma (cadeia padrão do SDK) |
| `SQS_WAGER_QUEUE_NAME` / `SQS_WAGER_DLQ_NAME` / `SQS_WAGER_EVENTS_QUEUE_NAME` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` / `wager-events.fifo` | nomes das filas; lidos também pelo compose (precisam terminar em `.fifo`) |
| `SQS_MAX_RECEIVE_COUNT` | `10` | redrive para a DLQ; lida **só pelo compose** |
| `HEALTH_CHECK_TIMEOUT_MS` | `2000` | timeout de cada check do readiness |
| `SQS_CONSUMER_ENABLED` | `true` | liga o consumidor |
| `SQS_CONSUMER_NAME` | `wager-transactions-consumer` | `consumer_name` da inbox; mudar faz mensagens já vistas parecerem novas para a inbox (a idempotência continua valendo) |
| `SQS_MAX_MESSAGES` | `10` | mensagens por `ReceiveMessage` (1–10) |
| `SQS_WAIT_TIME_SECONDS` | `20` | long polling (0–20) |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `60` | visibilidade pedida no receive |
| `SQS_RETRY_BASE_SECONDS` / `SQS_RETRY_MAX_SECONDS` | `30` / `300` | backoff do retry |
| `SQS_CONSUMER_MAX_ATTEMPTS` | `5` | tentativas antes da DLQ com motivo |
| `SQS_SHUTDOWN_TIMEOUT_MS` | `8000` | prazo de shutdown do consumidor |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | liga o publisher |
| `OUTBOX_BATCH_SIZE` | `10` | eventos por claim (1–10) |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | espera quando o claim volta vazio |
| `OUTBOX_SQS_TIMEOUT_MS` | `3000` | prazo do envio; `+ 2000 ≤ OUTBOX_IDLE_IN_TRANSACTION_TIMEOUT_MS` |
| `OUTBOX_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `15000` | o Postgres derruba a sessão travada |
| `OUTBOX_STUCK_ATTEMPTS` | `10` | a partir daqui, log `outbox_event_stuck` + gauge |
| `OUTBOX_SHUTDOWN_TIMEOUT_MS` | `8000` | prazo de shutdown do publisher |
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga o worker de pendentes |
| `PENDING_REFERENCE_BATCH_SIZE` | `10` | candidatas por ciclo (cada uma é uma transação) |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `1000` | espera quando nada avançou |
| `PENDING_REFERENCE_GAUGE_INTERVAL_MS` | `10000` | atualização do gauge de pendentes |
| `PENDING_REFERENCE_TTL_MS` | `3600000` | prazo da referência a partir do `createdAt` |
| `PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS` | `8000` | prazo de shutdown do worker |
| `SHUTDOWN_BUDGET_MS` | `25000` | teto da soma dos três prazos de shutdown |
| `FAULT_INJECTION` | `none` | só testes: `exit_after_commit_before_ack`, exige `NODE_ENV=test` |
| `MULTI_SEED` | aleatória | só `test:multi`: reproduz a carga |
| `LOG_LEVEL` | `info` | nível do pino (`trace`…`fatal`, `silent`); lida direto em `logger.ts`, fora do `loadConfig`, porque o logger existe antes da config |

Constantes fixas no código (não configuráveis): `lock_timeout` 2s, `statement_timeout` do claim 5s, pool 10 / acquire 10s, backoff das pendências 5s→10min, backoff da outbox 1s→5min, pausa dos loops até 30s (`errorPauseMs`, a mesma nos três loops). Todos os backoffs usam `exponentialBackoffMs` (`src/domain/backoff.ts`).

## Interpretações adotadas

Pontos em que a especificação deixa margem, e o que foi escolhido. O detalhe está na seção indicada.

- **Uma reversão no total por transação** (REFUND **ou** ROLLBACK), mais estrito que "uma por tipo" — [Regras de negócio](#regras-de-negócio).
- **ROLLBACK de REFUND** é permitido e não conta como segunda reversão da BET — [Regras de negócio](#regras-de-negócio).
- **WIN e LOSS podem referenciar a BET**, com as mesmas validações de uma reversão, exceto valor igual; sobre BET estornada, `REFERENCE_ALREADY_REVERSED` — [Regras de negócio](#regras-de-negócio).
- **Referência pendente aguarda** (a transação também fica `PENDING_REFERENCE`); só referência REJECTED/FAILED gera `REFERENCE_NOT_PROCESSED` — [Taxonomia de failureCode](#taxonomia-de-failurecode).
- **No prazo, referência ainda pendente também expira** com `REFERENCE_NOT_FOUND`; uma referência que chega depois não ressuscita a rejeição — [Worker de referências pendentes](#worker-de-referências-pendentes).
- **TTL de 1h a partir do `createdAt`**, em vez de limite de tentativas — [Worker de referências pendentes](#worker-de-referências-pendentes).
- **Idempotency key escopada por provider** `(provider_id, idempotency_key)`; o mesmo `externalTransactionId` sob outra key é conflito — [Idempotência](#idempotência).
- **`"25"` e `"25.5"` são aceitos** e normalizados para 2 casas; no hash, `"25"` e `"25.00"` são o mesmo payload — [Modelo de domínio](#modelo-de-domínio), [Idempotência](#idempotência).
- **`LOSS` aceita valor zero** e não gera lançamento — [Modelo de domínio](#modelo-de-domínio).
- **`FAILED` é respondido como 422**, não 503, porque é terminal e o replay devolve o mesmo resultado — [API HTTP](#api-http).
- **Rejeições no nível da wallet não devolvem saldo** (a wallet pode ser de outro jogador) — [Taxonomia de failureCode](#taxonomia-de-failurecode).
- **`providerId = "internal"` e keys `opening:`** são reservados para a OPENING — [API HTTP](#api-http).
- **Ids e textos limitados a 256 caracteres**; `InvalidInput` tem código único — [Idempotência](#idempotência).
- **A outbox não tem DLQ** e nunca descarta; um evento travado bloqueia só o próprio agregado — [Outbox publisher](#outbox-publisher).

## Pontos da especificação que geraram dúvida

Alguns requisitos do `CHALLENGE.md` se mostraram contraditórios entre si, ou só puderam ser atendidos juntos com uma solução de contorno. Ficam registrados aqui no formato conflito → como foi resolvido, para discussão. As escolhas comuns de projeto, onde a especificação só deixa margem, estão em [Interpretações adotadas](#interpretações-adotadas).

1. **Reversão dupla × crédito duplicado.**
   - *Conflito:* o §7 (regra 4) só proíbe reverter a mesma referência duas vezes **pelo mesmo tipo**. Assim, um REFUND seguido de um ROLLBACK da mesma BET seria válido, mas creditaria a aposta duas vezes, o que o §3 proíbe ("não pode duplicar créditos").
   - *Resolução:* cada transação pode ser revertida no máximo uma vez no total (REFUND **ou** ROLLBACK), garantido pelo índice único parcial `ux_wager_tx_one_reversal`. A invariante global prevaleceu sobre a regra mais permissiva. Ver [Regras de negócio](#regras-de-negócio).

2. **`version` na abertura da wallet.**
   - *Conflito:* o §6.2 diz que `version` incrementa sempre que o saldo muda. A abertura com saldo inicial muda o saldo (crédito OPENING), mas o exemplo do §9 devolve `version: 1`.
   - *Resolução:* a abertura é parte da criação da wallet. `Wallet.open` já nasce com o saldo inicial e `version = 1`, e devolve o lançamento OPENING sem incrementar. Ver [Abertura de wallet](#abertura-de-wallet).

3. **OPENING como `WagerTransaction`.**
   - *Conflito:* o §6.3 exige em toda transação `providerId`, `roundId`, `gameId`, `idempotencyKey` e `payloadHash`, mas a OPENING é interna e não tem nenhum desses dados.
   - *Resolução:* valores reservados para a transação interna (`providerId = "internal"`, `roundId = "opening"`, `gameId = "system"`, key `opening:<walletId>`). O provider `internal` e o kind OPENING são recusados na entrada, para nenhum provedor externo colidir com eles. Ver [API HTTP](#api-http).

4. **Rejeição auditável × garantias no schema.**
   - *Conflito:* a especificação pede que rejeições sejam persistidas (auditoria e replay) **e** que as garantias de consistência estejam no schema (§5.9). Uma rejeição por `WALLET_NOT_FOUND` ou `CURRENCY_MISMATCH` viola a FK composta `(wallet_id, currency) → wallets(id, currency)`, que é justamente a garantia de que transação e wallet têm a mesma moeda.
   - *Resolução:* a coluna gerada `wallet_fk_currency` vale `NULL` quando a transação está REJECTED ou FAILED. Com `MATCH SIMPLE`, a FK não é checada só nessas linhas e continua valendo para todas as outras. Ver [Garantias no schema](#garantias-no-schema).

5. **Limite de tentativas × fila FIFO.**
   - *Conflito:* o §10 exige fila FIFO, limite de tentativas antes da DLQ e retry com backoff. O SQS conta cada **recebimento** como tentativa, e numa FIFO as mensagens seguintes de um grupo são recebidas de novo a cada retry da primeira, sem serem processadas. Com um limite único, mensagens válidas iriam para a DLQ sem nunca terem sido tentadas.
   - *Resolução:* dois limites. O consumidor envia para a DLQ, com motivo e métrica, após 5 tentativas (`SQS_CONSUMER_MAX_ATTEMPTS`); a redrive policy da fila usa 10 (`SQS_MAX_RECEIVE_COUNT`), só como rede de segurança. O efeito colateral está em [Decisões e trade-offs](#decisões-e-trade-offs). Ver [Consumidor SQS](#consumidor-sqs).

6. **`FAILED` como erro permanente de infraestrutura.**
   - *Conflito:* o §6.3 define FAILED como estado terminal e auditável para "erro permanente de infraestrutura". Quando a infraestrutura que falha é o próprio banco, não há onde gravar esse estado.
   - *Resolução:* FAILED (`INFRASTRUCTURE_FAILURE`) registra só falhas que ainda podem ser persistidas: uma pendência que erra de forma inesperada 5 vezes seguidas no reprocessamento. Indisponibilidade do banco é tratada como falha transitória (retry com backoff e, ao esgotar, DLQ), nunca como FAILED. Ver [Worker de referências pendentes](#worker-de-referências-pendentes) e [Consumidor SQS](#consumidor-sqs).

## Decisões, trade-offs e limitações

### Decisões e trade-offs

- **MikroORM com `EntitySchema` e registros de persistência**, em vez de decorators no domínio: mais verboso, com cópia campo a campo e sem rastreamento de mudanças no objeto de domínio, em troca de um domínio sem ORM e de reidratação explícita.
- **Contexto do ORM explícito em todas as entradas:** um pouco mais de cerimônia em cada use case, em troca de HTTP, SQS e workers se comportarem igual.
- **Conexão preguiçosa:** uma `DATABASE_URL` errada não falha no boot, só aparece no readiness. Em troca, uma queda do banco não vira crash loop.
- **Pool com acquire timeout curto (10s):** sob contenção extrema, uma requisição falha (503) em vez de esperar mais; preferível a acumular latência sem limite.
- **Migrations em SQL à mão, com CLI próprio:** mais código para manter, e nada detecta automaticamente divergência entre o `EntitySchema` e o SQL (os testes de integração contra o banco real fazem isso).
- **FKs deferidas:** a ordem do flush não importa, mas a violação de FK só aparece no commit, não no statement.
- **`Money` em `bigint` com escala fixa 2:** moedas com outra escala (JPY, BHD) ou operações com divisão exigiriam introduzir escala por moeda e arredondamento.
- **Lock pessimista por wallet:** uma conexão fica ocupada esperando o lock (limitado pelo `lock_timeout` de 2s, que vira 503 reenviável), em troca de não reexecutar transações inteiras sob contenção.
- **Porta própria de readiness**, sem `@nestjs/terminus`: ~80 linhas nossas em vez de uma dependência.
- **Portas em loopback e LocalStack fixado em 4.9.2:** sem correções de versões futuras do LocalStack.
- **Filas sem dedup por conteúdo:** todo produtor precisa gerar o dedup id; em troca, dois payloads idênticos legítimos não são descartados por coincidência.
- **`maxReceiveCount` 10 e limite 5 no consumidor:** baixo demais mandaria para a DLQ mensagens que sobreviveriam a uma indisponibilidade curta; alto demais atrasaria a DLQ de mensagens inválidas. Efeito colateral aceito: uma mensagem que esperou atrás de outra (contagem já alta) e então falha de forma transitória vai para a DLQ com `MAX_ATTEMPTS_EXCEEDED` sem as próprias 5 tentativas. Contar tentativas reais exigiria estado por mensagem fora do SQS.
- **Abort do long polling no shutdown:** uma mensagem entregue à conexão abortada fica em voo até a visibilidade expirar (60s) e volta para outra instância, sem perda nem duplicação. A alternativa exigiria `stop_grace_period` acima de 20s só para o consumidor.
- **Outbox publicando com o lock da linha:** uma conexão do pool fica presa durante o envio (por isso lote ≤ 10 e envio com prazo de 3s); em troca, não há lease nem expiração para manter.
- **Ordem por agregado na outbox:** no máximo um evento por agregado por ciclo, e um evento que falha para sempre bloqueia os seguintes do mesmo agregado (os demais seguem).
- **Hooks de shutdown sequenciais:** parar os três em paralelo daria mais tempo a cada um, mas acoplaria módulos independentes; os prazos curtos atendem ao trabalho real.
- **Teste multi com processos locais, não containers:** permite SIGKILL e leitura de log por instância; o empacotamento Docker foi validado à parte, manualmente.

### Limitações

- **Autenticação não implementada:** qualquer cliente que alcance a API submete em nome de qualquer provider e lê transações, saldos e ledgers. O desenho está em [Autenticação](#autenticação).
- **Wallet sem vínculo com provider:** qualquer provider que conheça `walletId` + `playerId` movimenta a wallet. O vínculo (`wallet_providers`) faz parte do desenho de autenticação, não implementado.
- **REFUND de BET que já tem WIN PROCESSED é aceito.** A spec não proíbe, e o provedor pode estornar uma rodada cancelada depois de liquidada; o jogador fica com o prêmio e com o valor da aposta. Barrar exige definir a prioridade entre liquidação e estorno (decisão de negócio).
- **O banco não garante tudo do ledger:** compara o saldo com o **último** lançamento, não com a soma; não verifica o encadeamento `balance_before` = `balance_after` anterior, nem que só transação PROCESSED tenha lançamento, nem que o valor do lançamento seja o da transação. Garantem o domínio, o use case e o lock por wallet; a reconciliação detecta em produção, e `expectLedgerConsistent` verifica nos testes.
- **TRUNCATE não é bloqueado** pelos triggers: em produção, o usuário da aplicação não deve ter essa permissão.
- **C4a — mensagem não registrada na inbox:** se a primeira entrega de um `messageId` termina em `IdempotencyConflict` ou `InvalidInput`, nenhuma linha de inbox é gravada. Uma mensagem posterior com o mesmo `messageId` e outro payload válido é processada normalmente (com a própria idempotency key, sem duplicar efeito). Fechar exige gravar a inbox também nesses desfechos, o que muda o use case.
- **Sem heartbeat de visibilidade no consumidor:** um lote acima de 60s pode ser reentregue em paralelo; é seguro, mas desperdiça trabalho.
- **Outbox:** cada publisher ocupa uma conexão por lote (com N instâncias, até N conexões além do tráfego). Não existe consumidor de `wager-events` neste sistema, então a dedup por `eventId` do lado de lá é contrato, não testada aqui.
- **Worker de pendentes:** os contadores de erro e de `wallet_busy` são em memória por instância (zeram no restart; com N instâncias, encerrar como FAILED pode levar mais de 5 erros no total). Erros inesperados em mais de `batchSize` candidatas ao mesmo tempo seguram o lote até cada uma virar FAILED. Uma pendente cuja referência está em outra wallet não é antecipada pelo caminho rápido (é rejeitada no check normal). `start()` logo depois de um `stop()` que estourou o prazo é ignorado enquanto o loop antigo termina.
- **Métricas por instância** (o Prometheus soma); `/metrics` aberto, como os health checks.
- **`InvalidInput` com código único:** o motivo vem em texto; códigos por campo ficam para quando um consumidor precisar.
- **Rate limit** por provider ou wallet não existe; seria feito na borda.
- **Testes:** a sobreposição real na hot wallet do `test:multi` não é provada (o resultado não depende da ordem; a disputa no lock é provada pelo 80+80 e pela suíte de concorrência); "pegou trabalho em andamento" no item 8 é sanidade, e o ponto entre commit e ack é provado de forma determinística só pelo item 5; a distribuição da fila entre instâncias depende do broker (`SQS_MAX_MESSAGES=1` e grupos distintos tornam isso praticamente certo); a seed reproduz a carga, não a intercalação; o vínculo `SIGTERM` → shutdown hooks (`enableShutdownHooks`) foi verificado só manualmente, no profile `multi`.
