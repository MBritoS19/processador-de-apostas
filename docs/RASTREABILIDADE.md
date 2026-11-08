# Rastreabilidade: exigência → teste

Cada exigência verificável do `CHALLENGE.md`, com o teste que a prova. Gerada na varredura de 2026-11-07/08 e revisada em 2026-11-08, depois de uma avaliação independente. Revise ao mudar testes ou requisitos.

**Resumo:** 138 exigências · 137 cobertas · 1 não testável (§14, mocks: é propriedade da própria suíte). Antes da varredura eram 16 parciais e 1 ausente; os testes que fecharam essas lacunas estão marcados com **(novo)**.

Abreviações: `U` = `test/unit`, `I` = `test/integration`, `C` = `test/concurrency`, `M` = `test/multi`, `X` = `test/chaos`. Os nomes entre aspas são os títulos dos testes (prefixos encurtados).

## §3 Contexto do domínio

| # | Exigência | Teste | Status |
|---|---|---|---|
| 3.1 | A mesma operação chega várias vezes | C/process-wager-transaction "a mesma BET 50x em paralelo → 1 débito"; M/multi-instance item 1 (30 HTTP + 20 SQS → 1 transação) | COBERTO |
| 3.2 | Dependente antes da referência | I/workers/pending-references "ROLLBACK antes da BET → … worker resolve"; I/workers/pending-references-sqs "ROLLBACK antes da BET, ambos pela fila" | COBERTO |
| 3.3 | Várias instâncias na mesma wallet | M/multi-instance item 4 (hot wallet: 100 aceitas, 20 rejeitadas); I/sqs-consumer "duas instâncias com a mesma mensagem em paralelo" | COBERTO |
| 3.4 | Processo morre **antes** do commit | **(novo)** M/crash-before-commit "SIGKILL com a transação aberta: nada persiste, a mensagem volta e é processada uma única vez"; I/atomicity "falha na gravação de %s → nada persiste" | COBERTO |
| 3.5 | Processo morre **depois** do commit | M/multi-instance item 5 (`FAULT_INJECTION`, SIGKILL antes do `DeleteMessage`); I/sqs-consumer "worker morto depois do commit e antes do ack" | COBERTO |
| 3.6 | Eventos publicados mais de uma vez | I/outbox-publisher "exceção depois de publicar e antes do commit → outra instância republica o mesmo eventId; marcado uma vez" e "conexão do publisher morta (pg_terminate_backend)" | COBERTO |
| 3.7 | PostgreSQL temporariamente indisponível | **(novo)** X/infra-outage "Postgres fora do ar durante a carga: API 503, consumidor em retry sem DLQ, tudo retoma e fica consistente". A queda passou a durar 40s, acima da tolerância antiga do consumidor; o teste confere a entrada e a saída do modo "banco fora". Saída em [`docs/carga/chaos.txt`](carga/chaos.txt). I/sqs-consumer › modo "banco fora": "sem conexão: para de receber enquanto a sonda falha…", "banco fora não conta para o limite de tentativas…", "as mensagens em voo de outros grupos voltam sem tentativa…", "stop() interrompe a espera…" | COBERTO |
| 3.8 | SQS temporariamente indisponível | **(novo)** X/infra-outage "SQS fora do ar: eventos confirmados ficam na outbox até publicar; consumidor e publisher retomam sem perder nada" | COBERTO |
| 3.9 | Sem crédito duplicado | I/process "REFERENCE_ALREADY_REVERSED: %s sobre BET já estornada"; I/schema-constraints "rejeita ROLLBACK PROCESSED de uma BET que já tem REFUND"; M verificações 3–4 | COBERTO |
| 3.10 | Sem débito duplicado | C "a mesma BET 50x"; M item 1; X (uma linha e um lançamento por operação) | COBERTO |
| 3.11 | Sem perder evento confirmado | M verificações 6 e 6b; C/outbox-publishers "300 eventos em 30 agregados → todos publicados"; X (todo eventId chega à fila) | COBERTO |
| 3.12 | Sem saldo negativo | C "BETs concorrentes até esgotar o saldo: nunca negativo"; I/schema "rejeita saldo negativo", "rejeita UPDATE que deixaria o saldo negativo"; M verificação 2 | COBERTO |

## §5 Restrições invioláveis

| # | Exigência | Teste | Status |
|---|---|---|---|
| 5.1 | Dinheiro nunca é `number`/float | **(novo)** I/schema "toda coluna de valor é numeric(20,2) e não há float, real, double ou money"; U/money "add e subtract são exatos", "rejeita amount que não é string"; I/http "amount inválido → 400" | COBERTO |
| 5.2 | Idempotência sem cache em memória | M item 1 (3 processos, mesma aposta → 1 transação); M item 8 (replays depois do SIGKILL e reinício) | COBERTO |
| 5.3 | Não confiar só no FIFO | M "duplicatas SQS (mesmo messageId, dedup do broker distinto)"; I/sqs-consumer "a mesma mensagem entregue duas vezes" | COBERTO |
| 5.4 | Nenhum evento antes do commit | **(novo)** I/outbox-publisher "transação financeira aberta ou desfeita → nada publicado; depois do commit, os eventos saem" | COBERTO |
| 5.5 | Ledger sem UPDATE/DELETE | I/schema "UPDATE é bloqueado (append-only)", "DELETE é bloqueado (append-only)" | COBERTO |
| 5.6 | Sem lock global | **(novo)** C "wallet travada não bloqueia as outras: 12 wallets em paralelo processam enquanto A espera o lock" | COBERTO |
| 5.7 | Sem read → calculate → update descontrolado | C "cenário obrigatório 80+80"; I/process "UPDATE com version divergente → WalletVersionConflictError e rollback" | COBERTO |
| 5.8 | Correto com múltiplas instâncias | M/multi-instance (3 processos; falha se alguma não atender HTTP e SQS) | COBERTO |
| 5.9 | Garantias no schema | I/schema-constraints (todas as describes: wallets, saldo × ledger, transações, reversão única, imutabilidade, ledger, inbox/outbox) | COBERTO |

## §6 Modelo de domínio

| # | Exigência | Teste | Status |
|---|---|---|---|
| 6.0 | `rehydrate` não revalida | U/wallet "Wallet.rehydrate reconstrói o estado persistido sem revalidar"; U/wager-transaction "reconstrói estado terminal e OPENING sem revalidar"; U/wallet-ledger-entry "rehydrate não revalida" | COBERTO |
| 6.1a | `Money` imutável | U/money "é imutável: operações retornam nova instância" | COBERTO |
| 6.1b | String decimal, escala 2 | U/money "Money.from — escala"; I/round-trip (a coluna numeric guarda a mesma string) | COBERTO |
| 6.1c | Moedas diferentes → erro de domínio | U/money "Money — conflito de moeda" | COBERTO |
| 6.1d | Entradas inválidas rejeitadas | U/money "Money.from — entradas inválidas" (NaN, Infinity, notação científica, vazio, >2 casas, negativo) | COBERTO |
| 6.1e | Domínio sem ORM e sem NestJS | **(novo)** U/domain-boundary "nenhum arquivo de src/domain importa NestJS, MikroORM ou camadas externas" | COBERTO |
| 6.1f | Multi-moeda com conflito testado | U/wallet "moeda diferente da wallet lança CurrencyMismatchError"; I/process "CURRENCY_MISMATCH" | COBERTO |
| 6.2a | Uma wallet por player + moeda | I/schema "rejeita segunda wallet para o mesmo player e moeda"; I/http "duplicada → 409" | COBERTO |
| 6.2b | Saldo nunca negativo | U/wallet "cenário 80 + 80: a segunda aposta falha e o estado não muda"; I/schema (CHECK) | COBERTO |
| 6.2c | Saldo ↔ ledger nos dois sentidos | I/schema "saldo × ledger (constraint trigger no COMMIT)" (3 testes) | COBERTO |
| 6.2d | Sem lost update | C cenário 80+80 e "até esgotar o saldo" | COBERTO |
| 6.2e | Moeda da operação = moeda da wallet | U/wallet CurrencyMismatch; I/schema "rejeita moeda diferente da wallet em transação não rejeitada" | COBERTO |
| 6.2f | `version` 1 e incrementa só quando o saldo muda | U/wallet "abre … version 1", "valor zero não gera lançamento nem muda version", "version incrementa uma vez por movimentação" | COBERTO |
| 6.3a | Transições válidas | U/wager-transaction "WagerTransaction — transições válidas" | COBERTO |
| 6.3b | Terminais imutáveis | U/wager-transaction "`${terminal}` não aceita `${name}`"; I/schema "trigger de imutabilidade" | COBERTO |
| 6.3c | OPENING não submetível (API e fila) | U/wager-transaction "OPENING é interno"; I/http "OPENING enviado → 400"; **(novo)** I/sqs-consumer "OPENING pela fila: DLQ INVALID_PAYLOAD, nada gravado" | COBERTO |
| 6.3d | Mesma key, payload diferente = conflito | U/wager-transaction "matchesPayload"; I/process "mesma key com payload diferente → conflito, nada gravado" | COBERTO |
| 6.4a | Lançamento imutável, aritmética na factory | U/wallet-ledger-entry "a instância é congelada", "DEBIT/CREDIT: before ± money = after" | COBERTO |
| 6.4b | No máximo um lançamento por wallet e transação | I/schema "rejeita segundo lançamento da mesma transação na mesma wallet" | COBERTO |
| 6.4c | LOSS e REJECTED sem lançamento | I/process LOSS "sem lançamento e sem WalletBalanceChanged"; "saldo insuficiente → REJECTED … sem lançamento" | COBERTO |
| 6.5 | Inbox, saldo, ledger e outbox na mesma transação | I/atomicity "falha na gravação de %s (%s) → nada persiste; o reenvio idêntico aplica tudo uma vez" | COBERTO |

## §7 Regras de negócio

| # | Exigência | Teste | Status |
|---|---|---|---|
| 7.T1 | BET: débito, 1 DEBIT, rejeita sem saldo | I/process "BET › debita, grava lançamento DEBIT…", "saldo insuficiente → REJECTED" | COBERTO |
| 7.T2 | WIN: crédito, pode referenciar a BET | I/process "WIN › sem referência: credita", "com referência à BET da rodada" | COBERTO |
| 7.T3 | LOSS: sem saldo, sem ledger | I/process "LOSS › PROCESSED com o saldo observado, sem lançamento" | COBERTO |
| 7.T4 | REFUND: crédito, uma vez | I/process "REFUND › reverte a BET", "REFERENCE_ALREADY_REVERSED: segundo REFUND" | COBERTO |
| 7.T5 | ROLLBACK: inverso, uma vez | I/process "ROLLBACK › de BET → CREDIT", "de WIN → DEBIT", "de REFUND → DEBIT" | COBERTO |
| 7.1 | REFUND/ROLLBACK exigem referência | U/wager-transaction "%s exige referência"; "BET com referência é inválida", "%s não pode referenciar a si mesma" (as duas regras passaram para `WagerTransaction.create`) | COBERTO |
| 7.2 | Referência: mesmo provider, player, wallet, moeda e rodada | I/process "referência de outro provider não é encontrada", "REFERENCE_PLAYER_MISMATCH", "REFERENCE_WALLET_MISMATCH", "CURRENCY_MISMATCH na referência", "REFERENCE_ROUND_MISMATCH" | COBERTO |
| 7.3 | REFUND só de BET; ROLLBACK de BET/WIN/REFUND | I/process "REFUND referenciando WIN → INVALID_REFERENCE_KIND", "ROLLBACK de LOSS → INVALID_REFERENCE_KIND" | COBERTO |
| 7.4 | Não reverter duas vezes | I/process "REFERENCE_ALREADY_REVERSED" (3 testes); I/schema "uma reversão PROCESSED por referência" | COBERTO |
| 7.5 | Valor igual ao da referência | I/process "AMOUNT_MISMATCH" | COBERTO |
| 7.6 | REJECTED não altera saldo nem ledger | I/process "saldo insuficiente → … sem lançamento"; M verificação 5 | COBERTO |
| 7.7 | Replay devolve o resultado e o saldo da época | I/process "replay devolve o resultado original com o saldo da época"; "replay e conflito respondem sem esperar o lock da wallet (leitura antes do lock)" | COBERTO |
| 7.8 | Referência ausente → PENDING_REFERENCE | I/process "com referência inexistente → PENDING_REFERENCE", "referência ausente → PENDING_REFERENCE com evento na outbox" | COBERTO |
| 7.9 | Reversão que deixaria saldo negativo: código próprio | I/process "de WIN já gasto → REVERSAL_WOULD_OVERDRAW"; U/failure-code "saldo insuficiente em BET e reversão … são códigos distintos" | COBERTO |
| 7.1a | Worker agendado com backoff exponencial | I/workers/pending-references "backoff 5s, 10s, … com a última checagem no prazo" | COBERTO |
| 7.1b | Limite/TTL definido | idem + I/pending-references-sqs "PENDING_REFERENCE_TTL_MS chega ao use case e ao worker" | COBERTO |
| 7.1c | Esgotado: REJECTED REFERENCE_NOT_FOUND + evento | I/pending-references "expirado → REJECTED REFERENCE_NOT_FOUND + evento na mesma transação" | COBERTO |
| 7.2x | `failureCode` estável | U/failure-code "taxonomia de FailureCode é estável e sem duplicatas" | COBERTO |

## §8 Concorrência

| # | Exigência | Teste | Status |
|---|---|---|---|
| 8.0 | Cenário obrigatório 100 − 80 − 80 | C "cenário obrigatório: … uma PROCESSED, uma REJECTED, saldo 20.00, um débito"; o teste prova a sobreposição (as duas BETs esperando o lock ao mesmo tempo, via `pg_stat_activity`) e reenvia as duas depois (replay idêntico, sem novo débito); M item 4 (em duas instâncias) | COBERTO |
| 8.1 | Duas apostas disputam o saldo | idem | COBERTO |
| 8.2 | Vários workers na mesma wallet | I/sqs-consumer "duas instâncias com a mesma mensagem em paralelo"; M hot wallet | COBERTO |
| 8.3 | Wallets diferentes em paralelo | **(novo)** C "wallet travada não bloqueia as outras"; M 12 wallets aleatórias | COBERTO |
| 8.4 | Três ou mais instâncias | M/multi-instance | COBERTO |

## §9 API HTTP

| # | Exigência | Teste | Status |
|---|---|---|---|
| 9.1 | `POST /wallets` | I/http "grava wallet, OPENING, CREDIT e WalletBalanceChanged na mesma transação, com version 1" | COBERTO |
| 9.2 | OPENING na mesma transação SQL | idem + I/schema "rejeita wallet aberta com saldo sem lançamento" (commit barrado) | COBERTO |
| 9.3 | Wallet duplicada → conflito | I/http "duplicada (mesmo player e moeda) → 409" | COBERTO |
| 9.4 | Consultas (wallet, transação por id e por provider + externo) | I/http "GET de wallet e de transação…", "404 NOT_FOUND quando não existe" | COBERTO |
| 9.5 | Cursor estável e opaco | I/http "ledger paginado" (4 testes: sem duplicar nem pular com inserções, mesma página antes e depois, inválido → 400) | COBERTO |
| 9.6 | `Idempotency-Key` obrigatório | I/http "Idempotency-Key ausente ou vazio → 400" | COBERTO |
| 9.7 | Replay → `idempotentReplay: true` | I/http "Processed → 200; replay idêntico → mesmo status e idempotentReplay: true" | COBERTO |
| 9.8 | Mesma key, outro payload → conflito | I/http "mesma key com payload diferente → 409 IDEMPOTENCY_CONFLICT" | COBERTO |
| 9.9 | Hash de JSON canônico, sem header | U/payload-hash (5 testes); I/process "header e metadados não entram no hash" | COBERTO |
| 9.10 | 400 payload inválido | I/http "amount inválido → 400", "JSON malformado → 400" | COBERTO |
| 9.11 | 409 conflito de idempotência | I/http (9.8) | COBERTO |
| 9.12 | 422 rejeição de negócio | I/http "Rejected → 422 com failureCode" | COBERTO |
| 9.13 | 202 aceite pendente | I/http "PendingReference → 202 com nextReferenceCheckAt" | COBERTO |
| 9.14 | 503 falha transitória | I/http "lock da wallet ocupado → 503 TRANSIENT_FAILURE com Retry-After"; X/infra-outage (banco parado: toda submissão 503 com Retry-After) | COBERTO |
| 9.15 | Reconciliação: log + métrica + sinalização, sem corrigir | I/http "divergente: sinaliza, conta na métrica e não corrige o saldo" (**novo**: verifica o log `reconciliation_divergence`; só tipos e ids, sem valores). I/http › "cruza ledger × transações": um teste por tipo de divergência (`ENTRY_WITHOUT_PROCESSED_TRANSACTION`, `ENTRY_TRANSACTION_DOES_NOT_MOVE_BALANCE`, `ENTRY_AMOUNT_MISMATCH`, `ENTRY_DIRECTION_MISMATCH` (BET e ROLLBACK de WIN), `PROCESSED_WITHOUT_ENTRY`, `PROCESSED_WITH_MULTIPLE_ENTRIES`, várias juntas), mais os consistentes: "wallet só com a abertura", "saldo zero", "BET, WIN, LOSS, REFUND e ROLLBACK de WIN" | COBERTO |
| 9.16 | `/health/live` e `/health/ready` | I/health (5 testes, inclusive Postgres e SQS inalcançáveis) | COBERTO |
| 9.17 | Health sem autenticação | **(novo)** I/health "health checks fora do AuthGuard" (guard negando tudo: health 200, wagering 403) | COBERTO |

## §10 Consumidor SQS

| # | Exigência | Teste | Status |
|---|---|---|---|
| 10.1 | Mesmo use case do HTTP | M item 1 (HTTP e SQS com a mesma key → 1 transação); I/sqs-consumer "outro messageId com a mesma idempotencyKey: replay pelo use case" | COBERTO |
| 10.2 | Dedup por inbox persistente | I/sqs-consumer "a mesma mensagem entregue duas vezes: a inbox confirma a 2ª sem chamar o use case"; "mesmo messageId com "25" e depois "25.00": mesma mensagem (hash normalizado)…"; U/wager-envelope "hash da inbox usa a normalização da transação…" | COBERTO |
| 10.3 | Ack só depois do commit | I/sqs-consumer "worker morto depois do commit e antes do ack"; M item 5 | COBERTO |
| 10.4 | Negócio (ack), transitório (retry), permanente (DLQ) | I/sqs-consumer "rejeição de negócio: ack…", "falha transitória: visibilidade 30/60/120/240…", "envelope que estoura o parser: DLQ INVALID_ENVELOPE" | COBERTO |
| 10.5 | Limite de tentativas antes da DLQ | I/sqs-consumer "falha transitória além do limite do consumidor (5, fila em 10): DLQ MAX_ATTEMPTS_EXCEEDED"; "banco fora não conta para o limite de tentativas do consumidor" e "lock_timeout … não ativa o modo" | COBERTO |
| 10.6 | SIGTERM: conclui ou devolve a visibilidade | I/sqs-consumer "SIGTERM com mensagem em andamento dentro do prazo", "SIGTERM além do prazo: devolve a visibilidade" | COBERTO |
| 10.7 | Redelivery sem duplicar | I/sqs-consumer "a mesma mensagem entregue duas vezes"; M item 5 | COBERTO |

## §11 Transactional Outbox

| # | Exigência | Teste | Status |
|---|---|---|---|
| 11.1 | Atomicidade transação + saldo + ledger + inbox + evento | I/atomicity (5 + 4 casos, inclusive falha só no 2º evento) | COBERTO |
| 11.2 | Publishers concorrentes sem perder nem duplicar indefinidamente | C/outbox-publishers "300 eventos em 30 agregados"; I/outbox "save só grava linha pendente…" | COBERTO |
| 11.3 | Passo 1: o Postgres confirma o commit | M item 5 (SQL: transação, lançamento, inbox e 3 eventos pendentes) | COBERTO |
| 11.4 | Passo 2: o processo morre antes de publicar | M item 5 (F com publisher desligado, SIGKILL); I/outbox "exceção depois de publicar e antes do commit" | COBERTO |
| 11.5 | Passo 3: outra instância assume | M item 5 (A, B e C publicam a outbox da F) | COBERTO |
| 11.6 | Passo 4: o evento é publicado | M verificação 6 (todo eventId na fila de eventos) | COBERTO |
| 11.7 | Passo 5: duplicata segura (mesmo eventId) | I/outbox "outra instância republica o mesmo eventId; marcado uma vez" | COBERTO |
| 11.8 | `WagerTransactionProcessed`, inclusive LOSS | I/process LOSS (outbox = `['WagerTransactionProcessed']`); M verificação 6b | COBERTO |
| 11.9 | `WagerTransactionRejected` | I/process e I/pending-references (expirado + evento); M verificação 6b | COBERTO |
| 11.10 | `WalletBalanceChanged` só quando o saldo muda | I/process LOSS (sem o evento); I/http "saldo zero não gera OPENING, lançamento nem evento"; M "todo lançamento com exatamente um WalletBalanceChanged" | COBERTO |
| 11.11 | `WagerTransactionPendingReference` | I/process "REFUND › referência ausente → PENDING_REFERENCE com evento na outbox" | COBERTO |

## §12 Observabilidade

| # | Exigência | Teste | Status |
|---|---|---|---|
| 12.1 | Logs JSON com correlationId, messageId, transactionId, walletId, providerId | **(novo)** I/sqs-consumer "logs do processamento: campos de correlação presentes, sem valores nem payload" | COBERTO |
| 12.2 | Sem dados sensíveis nem payload financeiro | idem (valor, saldo, player, rodada, jogo e `money`/`amount`/`data` ausentes); U/process "log estruturado sem payload" | COBERTO |
| 12.3 | Métrica: transações por status | I/http "/metrics é aberto e só tem labels de conjunto fechado" | COBERTO |
| 12.4 | Métrica: duplicatas | idem (`wagering_idempotent_replays_total`); I/sqs-consumer (contador `replays`) | COBERTO |
| 12.5 | Métrica: retries | I/sqs-consumer "falha transitória …" (`retries` = 4); X (retries > 0 na queda do banco) | COBERTO |
| 12.6 | Métrica: mensagens em DLQ | I/sqs-consumer "falha transitória além do limite" (`dlqMessages` = 1) | COBERTO |
| 12.7 | Métrica: conflitos de lock | I/http "lock da wallet ocupado → 503 … e conflito na métrica" (2 conflitos: a tentativa extra interna também conta); U/process "lock_timeout no caminho com lock: 1 tentativa extra, depois TransientFailure" | COBERTO |
| 12.8 | Métrica: outbox lag | I/outbox "outbox lag e eventos travados: gauges medidos a partir do pendente mais antigo" | COBERTO |
| 12.9 | Métrica: latência de processamento | **(novo)** I/http "/metrics …": `wagering_processing_duration_seconds_count` cresce 1 por execução | COBERTO |
| 12.10 | Liveness e readiness separados | I/health "GET /health/live continua 200 (liveness não depende de terceiros)" | COBERTO |

## §13 Testes obrigatórios

| # | Exigência | Teste | Status |
|---|---|---|---|
| 13.U1–U5 | Unidade: Money, Wallet, regras BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, payload divergente | U/money, U/wallet, U/wager-transaction ("ledgerDirectionFor", "affectsBalance"…), U/money "conflito de moeda", U/wager-transaction "matchesPayload" | COBERTO |
| 13.I1 | Migrations e constraints | I/migrations (up, down, up), I/migrate-cli, I/schema-constraints | COBERTO |
| 13.I2 | Atomicidade wallet, ledger, inbox, outbox | I/atomicity | COBERTO |
| 13.I3 | Inbox e redelivery | I/sqs-consumer (entrega dupla, worker morto antes do ack) | COBERTO |
| 13.I4 | Publishers concorrentes | I/outbox (pg_terminate_backend, idle timeout); C/outbox-publishers | COBERTO |
| 13.I5 | Retry e DLQ | I/sqs-consumer (backoff, limite, DLQ) | COBERTO |
| 13.I6 | Recuperação após reinicialização | M item 8; I/outbox (sessão morta); X (Postgres reiniciado; saída em [`docs/carga/chaos.txt`](carga/chaos.txt)) | COBERTO |
| 13.C1 | Mesma aposta 50x → um débito | C "a mesma BET 50x"; M item 1 | COBERTO |
| 13.C2 | Disputa de saldo | C cenário 80+80 | COBERTO |
| 13.C3 | Wallets distintas em paralelo | **(novo)** C "wallet travada não bloqueia as outras" | COBERTO |
| 13.C4 | Três ou mais processos | M/multi-instance | COBERTO |
| 13.C5 | Morto depois do commit e antes do ack | M item 5 | COBERTO |
| 13.C6 | Dois publishers sobre a mesma outbox | C/outbox-publishers (2 testes) | COBERTO |
| 13.C7 | ROLLBACK/REFUND antes da referência | C/pending-references (2 testes); I/pending-references | COBERTO |
| 13.C8 | Reinício com consistência final | M item 8 + verificações finais por SQL | COBERTO |
| 13.F | Invariante final saldo == ledger | `expectLedgerConsistent` (afterEach do I/http e nos testes que movem saldo); M, X e M/crash por SQL sobre todas as wallets | COBERTO |

## §14 Falhas eliminatórias

| # | Exigência | Teste | Status |
|---|---|---|---|
| 14.1 | `number` para dinheiro | 5.1 + mutação 8 | COBERTO |
| 14.2 | Saldo negativo por race | C "até esgotar o saldo"; mutação 5 (o CHECK do banco barra) | COBERTO |
| 14.3 | Débito ou crédito duplicado | 3.9, 3.10; mutações 2 e 6 | COBERTO |
| 14.4 | Idempotência só em memória | 5.2 (entre processos e depois de reinício) | COBERTO |
| 14.5 | Correta só com uma instância | M/multi-instance | COBERTO |
| 14.6 | Evento antes do commit | 5.4 + mutação 3 | COBERTO |
| 14.7 | Sem ledger auditável | I/schema append-only; I/http reconciliação; I/http "ledger paginado" | COBERTO |
| 14.8 | Testes que trocam PostgreSQL e SQS por mocks | — | NÃO TESTÁVEL: é uma propriedade da suíte, não do sistema. Verificado por inspeção: integração, concorrência, multi e chaos usam o Postgres e o LocalStack reais; só a unidade usa dublês. |

## Teste de mutação

Cada mutação foi aplicada à mão, os testes relevantes foram rodados e o arquivo foi revertido com `git checkout`. Nenhuma mutação foi commitada.

| # | Mutação | Onde | Teste que falhou | OK |
|---|---|---|---|---|
| 1 | Sem `FOR UPDATE` na wallet | `lockWallet` (`mikro-orm-wager-unit-of-work.ts`) | C "wallet travada não bloqueia as outras" **(novo)** | ✅ |
| 2 | Pular a checagem de idempotência (sempre inserir) | `decideIdempotency` ignorado (`process-wager-transaction.ts`) | I/process "outra mensagem com a mesma transação → replay, e a nova mensagem fica registrada" | ✅ |
| 3 | Evento gravado fora da transação financeira (commitado antes) | `insertOutbox` em transação própria | I/outbox "transação financeira aberta ou desfeita → nada publicado" **(novo)**; I/atomicity "falha na gravação de inbox_messages" | ✅ |
| 4 | Ack da mensagem antes do use case | `decide` (`wager-consumer.ts`) | I/sqs-consumer "falha transitória …", "erro inesperado …", "falha transitória além do limite …", "worker morto depois do commit e antes do ack" | ✅ |
| 5 | Sem checagem de saldo no domínio | `Wallet.debit` | C cenário 80+80 e "até esgotar o saldo"; I/process "saldo insuficiente → REJECTED" (+4); U/wallet "cenário 80 + 80". O CHECK `balance >= 0` barrou: nenhuma wallet ficou negativa | ✅ |
| 6 | Permitir segunda reversão da mesma BET | `hasProcessedReversal` ignorado (`wager-settlement.ts`) | I/process "REFERENCE_ALREADY_REVERSED" (4 testes); I/pending-references "referência já estornada no momento da resolução". O índice `ux_wager_tx_one_reversal` barrou: nenhuma reversão dupla gravada | ✅ |
| 7 | Sem gravar a inbox | `insertInbox` vira no-op | I/atomicity (5 casos); I/sqs-consumer "mensagem válida …", "entregue duas vezes", "worker morto …" | ✅ |
| 8 | `Money.add` com `parseFloat` | `money.ts` | U/money "add e subtract são exatos (sem erro de ponto flutuante)" | ✅ |

**O que as mutações mostraram:**
- **M1 e M2 só foram pegas por um teste cada, e de propósito:** a correção financeira continuou intacta. Sem o `FOR UPDATE`, o `UPDATE … WHERE version` (lock otimista) barra o lost update; sem a checagem de idempotência, o `UNIQUE` do banco força o rollback e a releitura (caminho 23505). São as verificações duplicadas entre código e schema. Os testes que falham provam a perda da camada que foi removida.
- **M3 revelou uma lacuna no próprio teste novo:** a primeira versão segurava a transação *na* gravação da outbox, e assim não distinguia outbox dentro ou fora da transação. O portão foi movido para a inbox, que é gravada depois da outbox, e o teste passou a pegar a mutação.
