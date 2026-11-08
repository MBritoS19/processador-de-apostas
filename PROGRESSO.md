# Progresso

Legenda: `[ ]` pendente · `[~]` em andamento · `[x]` concluído (com testes passando)

Estado: **entregue** (tag `v1.1-entrega`, com o diário de partidas dobradas mesclado na `main`; ajustes pós-avaliação em andamento para a `v1.2-entrega`). Fases 0–10 concluídas em 2026-11-07; opcionais e diário em 2026-11-08.

---

## Fase 0 — Setup do projeto
- [x] Projeto NestJS com Bun e TypeScript strict
- [x] `docker-compose.yml`: PostgreSQL + LocalStack
- [x] Criação das filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo`, com redrive policy
- [x] MikroORM configurado, com migrations rodando (up e down)
- [x] Scripts do `package.json` batendo com a documentação
- [x] `GET /health/live` e `GET /health/ready` (Postgres + SQS)

## Fase 1 — Domínio (CHALLENGE.md §6, §7)
- [x] `Money`: imutável, escala 2, validação de entradas (NaN, Infinity, notação científica, vazio, mais de 2 casas, negativo)
- [x] `Money`: conflito de moeda lança erro de domínio
- [x] `Wallet`: `open`, `rehydrate`, `debit`, `credit`, saldo nunca negativo, `version` incrementa só quando o saldo muda
- [x] `WagerTransaction`: estados, transições válidas, terminais imutáveis
- [x] `WalletLedgerEntry`: imutável, `isBalanced` validado na factory
- [x] `InboxMessage` e `OutboxMessage` (com backoff em `scheduleRetry`)
- [x] `IntegrationEvent` abstrato + os 4 eventos concretos
- [x] Taxonomia de `FailureCode` definida
- [x] Testes unitários de todo o domínio

## Fase 2 — Schema e persistência (§5.9, §6)
- [x] Tabelas: wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages
- [x] Constraint: uma wallet por `(player_id, currency)`
- [x] Constraint: `balance >= 0`
- [x] Unicidade de `idempotency_key` e de `(provider_id, external_transaction_id)`
- [x] No máximo um lançamento por `(wallet_id, transaction_id)`
- [x] CHECK de aritmética do ledger (`balance_before ± money = balance_after`)
- [x] Trigger que bloqueia UPDATE e DELETE no ledger
- [x] Uma reversão por referência e por tipo (índice único parcial; depois endurecida para uma reversão no total, `ux_wager_tx_one_reversal`)
- [x] Inbox único por `(consumer_name, message_id)`
- [x] Mapeamento de `Money` ↔ `numeric(20,2)` + `currency`
- [x] Testes de integração das migrations e das constraints

## Fase 3 — Use case de processamento (§7, §8)
- [x] `payloadHash` com JSON canônico (algoritmo documentado)
- [x] Replay idempotente devolve a resposta original, incluindo o saldo daquele momento
- [x] Mesma key com payload diferente gera conflito
- [x] Regras de BET, WIN, LOSS, REFUND e ROLLBACK
- [x] Validação da referência (mesmo provider, player, wallet, moeda e rodada)
- [x] Reversão que deixaria saldo negativo é rejeitada com `failureCode` próprio
- [x] Referência ausente vira `PENDING_REFERENCE`
- [x] Estratégia de concorrência por wallet implementada e documentada
- [x] Eventos gravados na outbox na mesma transação
- [x] Cenário obrigatório: saldo 100, duas apostas de 80 → uma PROCESSED, uma REJECTED, saldo 20, um débito

## Fase 4 — API HTTP (§9)
- [x] `POST /wallets` com transação `OPENING` + lançamento CREDIT na mesma transação
- [x] Wallet duplicada retorna conflito
- [x] `POST /wagering/transactions` com `Idempotency-Key` obrigatório
- [x] Endpoints de consulta (wallet, transação por id, transação por provider + id externo)
- [x] Ledger com cursor estável e opaco
- [x] `POST /wallets/:id/reconciliation` (divergência: log + métrica + sinalização na resposta)
- [x] Mapeamento de status HTTP consistente e documentado
- [x] Ponto de extensão de autenticação (decisão registrada)

## Fase 5 — Consumidor SQS (§10)
- [x] Reutiliza o mesmo use case da entrada HTTP
- [x] Dedup via inbox persistente
- [x] Ack somente após o commit
- [x] Classificação de erros: negócio (ack), transitório (retry), permanente (DLQ)
- [x] Limite de tentativas antes da DLQ
- [x] Shutdown gracioso no `SIGTERM`

## Fase 6 — Outbox publisher (§11)
- [x] Worker com `FOR UPDATE SKIP LOCKED` (ou equivalente)
- [x] Backoff e retry
- [x] Seguro com múltiplos publishers
- [x] Publicação duplicada continua segura para o consumidor (mesmo `eventId`; dedup por `eventId` é contrato do consumidor, ARCHITECTURE.md → "Outbox publisher")

## Fase 7 — Worker de referências pendentes (§7.1)
- [x] Reprocessamento com backoff exponencial (mesmas regras via `WagerSettlement`; lock wallet → transação)
- [x] Limite de tentativas ou TTL definido e justificado (TTL 1h do `createdAt`, ARCHITECTURE.md → "Worker de referências pendentes")
- [x] Ao esgotar: `REJECTED` + evento publicado (`REFERENCE_NOT_FOUND` + `WagerTransactionRejected` na outbox, mesmo commit)

## Fase 8 — Observabilidade (§12)
- [x] Logs JSON com `correlationId`, `transactionId`, `walletId`, `providerId` (HTTP e use case)
- [x] `messageId` nos logs (Fase 5)
- [x] Métricas: transações por status, duplicatas, conflitos de lock, latência e divergência de reconciliação
- [x] Métricas de retries, DLQ e outbox lag declaradas no registry
- [x] Retries e DLQ incrementados (Fase 5)
- [x] Outbox lag medido (Fase 6)
- [x] `correlationId` propagado até os eventos da outbox

## Fase 9 — Testes de integração e concorrência (§13)
Integração:
- [x] Atomicidade entre wallet, ledger, inbox e outbox (use case e resolução pelo worker de pendentes)
- [x] Inbox e redelivery
- [x] Retry e DLQ
- [x] Recuperação após reinicialização

Concorrência (paralelismo real):
- [x] 1. Mesma aposta 50x em paralelo → um único débito (num processo e, no multi, 30 HTTP nas 3 instâncias + 20 SQS)
- [x] 2. Disputa de saldo na mesma wallet (cenário 80 + 80)
- [x] 3. Wallets distintas em paralelo
- [x] 4. 3 ou mais instâncias simultâneas (`test:multi`: 3 processos reais; falha se alguma não atender HTTP e SQS)
- [x] 5. Worker morto depois do commit e antes do ack (`FAULT_INJECTION`, só com `NODE_ENV=test`)
- [x] 6. Dois publishers sobre a mesma outbox
- [x] 7. ROLLBACK/REFUND entregue antes da referência (Fase 7: HTTP/use case, fila SQS, dois workers, worker + use case)
- [x] 8. Reinício do serviço com consistência final comprovada (SIGKILL das 3 no meio da carga + verificações por SQL)
- [x] Invariante final em todos: `wallet.balance == saldo reconstruído pelo ledger`

## Fase 10 — Documentação (concluída em 2026-11-07)
- [x] `README.md`: setup e comandos (provado num clone limpo)
- [x] `ARCHITECTURE.md`: ORM, mapeamento de `Money`, estratégia transacional e de concorrência, transições de estado, `failureCode`, status HTTP, algoritmo de hash, TTL das pendências, autenticação, trade-offs e limitações


## Varredura de requisitos (2026-11-08)
- [x] Matriz exigência → teste para todo o `CHALLENGE.md` (`docs/RASTREABILIDADE.md`): 137 cobertas, 1 não testável
- [x] Lacunas fechadas: morte antes do commit (multi), Postgres/SQS fora do ar (`test:chaos`), evento antes do commit, sem lock global, tipos monetários no schema, fronteira do domínio, OPENING pela fila, health fora do guard, logs do consumidor, log da reconciliação, latência
- [x] Teste de mutação manual: 8 mutações, todas pegas por pelo menos um teste

## Primeira avaliação independente e correções (2026-11-08)
Avaliação a partir de um clone limpo, por critério da §14 do CHALLENGE: nenhuma falha eliminatória. Correções:
- [x] `main` verde (`test:load` no contrato de scripts), CI em `.github/workflows/ci.yml` (typecheck + unit; integração com o próprio compose), README (nome fixo do projeto no compose, aplicação de pé nos testes, seed fixa do multi, tempos, Estrutura), ARCHITECTURE (seed, CI, retenção da inbox, replay de FAILED)
- [x] Reconciliação como use case (`ReconcileWallet`), cruzando ledger × transações (7 tipos de divergência, um teste de integração por tipo); consumidor com modo "banco fora" (só erro de conexão; para de receber e sonda o Postgres; mensagem fora do limite de tentativas; gauge `wagering_consumer_db_unavailable`); pool esgotado separado (`pool_exhausted`); `test:chaos` com o Postgres parado 40s
- [x] 80+80 com sobreposição provada e reenvio; BET sem referência e "não referencia a si mesma" em `WagerTransaction.create`; leitura de idempotência sem lock antes do caminho com lock; hash da inbox normalizado; 1 tentativa extra interna em `lock_timeout` (orçamento de espera mantido em ~2s: 2 tentativas de 1s); sonda do modo "banco fora" com teto de 5s
- [x] Evidência do `test:chaos` em `docs/carga/chaos.txt`

## Fechamento da entrega
- [x] Comentários de "porquê" nos pontos críticos, com referência à spec
- [x] Checklist de entrega: `.env` fora do git; clone limpo do remoto seguindo só o README (compose isolado, install, migration:up, `bun test`: 611 pass, 13 skip, 0 fail)
- [x] Rodada final, resumo em `docs/carga/final/RESUMO.md`: typecheck ok, unit 296, integração 304 (3 rodadas seguidas, 0 falha), concorrência 9, multi 2, chaos 2
- [x] `bun run demo`: cenário obrigatório (saldo 100, duas BETs de 80 em paralelo → uma PROCESSED, uma REJECTED `INSUFFICIENT_BALANCE`, saldo 20, reconciliação consistente)
- [x] README: badge de CI e diagrama Mermaid do fluxo; ARCHITECTURE.md → "Evolução futura"
- [x] Mutex local por wallet: implementado no branch `feat/mutex-local` e medido com o cenário `quente-frias` (3 rodadas antes + 3 depois, alternadas). Frias p95 −96%, mas quente PROCESSED/s −47% e 503 de 0 para 40: **não adotado**. Resultado em `docs/CARGA.md` → "Mutex local por wallet: medido, não adotado"; JSONs em `docs/carga/mutex/`
- [x] Tag `v1.0-entrega`; desempate determinístico das pendentes (`511fee4`, tag `v1.0.1-entrega`)

## Opcionais
- [ ] Autenticação com Keycloak ou Zitadel — não implementada por decisão: não vale pontos (CHALLENGE §2, "Autenticação — a cargo do candidato"); `AuthGuard` no-op e desenho (Keycloak client credentials, vínculo `wallet_providers`) documentados em ARCHITECTURE.md → "Autenticação"
- [x] Teste de carga (`bun run test:load`) com p50/p95/p99, erros, conflitos e outbox lag (metodologia em ARCHITECTURE.md → "Estratégia de testes"; análise e dados em `docs/CARGA.md` e `docs/carga/`)
- [x] Ledger de partidas dobradas: diário paralelo ao ledger, **mesclado na `main`** (tag `v1.1-entrega`); ARCHITECTURE.md → "Diário de partidas dobradas"

## Diário de partidas dobradas (2026-11-08, mesclado — tag `v1.1-entrega`)
Critério de adoção: todas as suítes verdes 3× e p95 de `quente-frias` até +20% sobre a `main`, sem erros novos.
- [x] 1. Domínio: `JournalEntry` (débito = crédito, uma moeda, ≥ 2 pernas, imutável) e `forTransaction` (perna PLAYER com a direção do lançamento da wallet; contrapartida FUNDING no OPENING, PROVIDER_HOUSE do provider nos demais)
- [x] 2. Migration `…20261109000000_double_entry_journal`: `accounts`, `journal_entries`, `journal_postings`; append-only (23001); constraint trigger deferido `trg_journal_balanced` (23514); FUNDING para BRL, USD e moedas existentes (moeda nova: sob demanda); backfill do ledger; `down` remove só o diário
- [x] 3. Persistência: `insertJournalEntry` em SQL direto (`journal.persistence.ts`): contas pela chave natural numa consulta, as que faltam com `on conflict do nothing` + releitura; lançamento e pernas num statement
- [x] 4. Gravação dupla em `WagerSettlement` (use case e worker de pendentes) e `OpenWallet`, logo após o lançamento da wallet. Erro do diário: HTTP 500; SQS direto para a DLQ `JOURNAL_INTEGRITY_VIOLATION`, sem retry
- [x] 5. Reconciliação: `journalBalance` na resposta; `JOURNAL_BALANCE_MISMATCH` = diário ≠ saldo guardado
- [x] 6. Concorrência (`test/concurrency/journal.test.ts`: 3 instâncias, 6 wallets, 2 providers, HOUSE nascendo disputada); `expectConsistent` (multi e carga) confere o diário
- [x] 7. Carga A/B `quente-frias` (3 + 3 rodadas alternadas, medianas): p95 geral +18,7% (critério ≤ +20%: atingido), 0 erro novo; vazão −18%. Dados em `docs/carga/partidas-dobradas/`, análise em `docs/CARGA.md`
- [x] Critério de adoção: depois do desempate das pendentes (`511fee4`), 3 rodadas verdes (typecheck, unit 327, integração 354, concorrência 10, multi 2, chaos 2) e CI verde; merge `--no-ff` na `main`, tag `v1.1-entrega`

## Ajustes pós-avaliação (branch `fix/pos-banca`, 2026-11-08)
Segunda avaliação independente da `v1.1-entrega` (clone limpo, stack isolada): nenhuma falha eliminatória; principal achado, um intermitente no **teste** multi-instância.
- [x] `test:multi`: contagens por linha de log esperam a linha (poll com prazo) em vez de ler logo depois de a fila zerar
- [x] Docs: este arquivo como histórico neutro; README com "Limitações conhecidas", aviso do `test:chaos` e "Uso de IA"; ARCHITECTURE com o diário na lista de SQL da transação e nas migrations
- [x] BET → REFUND → ROLLBACK do REFUND: comportamento documentado (ARCHITECTURE.md → "Regras de negócio", "Interpretações adotadas") e provado por teste de integração; regra inalterada
- [x] `test:load` completo sobre o código entregue (`33f8049`): 7/7 rodadas com consistência ok, 0 erro, 0 503; `docs/CARGA.md` reescrito com a rodada oficial nova, a comparação com a anterior e o custo do diário

---

## Decisões tomadas
<!-- Uma linha por decisão; o detalhe vai no ARCHITECTURE.md -->
- MikroORM 6 com `EntitySchema` em infrastructure (domínio sem ORM) — ARCHITECTURE.md → "Persistência"
- Migrations em SQL escrito à mão, CLI próprio via `getMigrator()` — "Persistência"
- LocalStack fixado em 4.9.2 (sem auth token); MiniStack como alternativa — "Infraestrutura local"
- Filas FIFO sem dedup por conteúdo; redrive para DLQ com `maxReceiveCount=10` (rede de segurança; revisto na Fase 5) — "Infraestrutura local", "Consumidor SQS"
- Liveness não toca dependências; readiness com porta `ReadinessCheck`, 503 e `reason` fechado (timeout|unreachable|error) — "Observabilidade"
- Contexto do ORM explícito em todas as entradas (`allowGlobalContext:false`, `registerRequestContext:false`) — "Persistência"
- Conexão preguiçosa no app: sobe com o Postgres fora e reporta not_ready (sem crash loop) — "Persistência"
- Módulos Nest por responsabilidade (Config global, Persistence, Messaging, Health) — "Stack e estrutura"
- `Money` em `bigint` de centavos, escala fixa 2, até 18 dígitos inteiros; "25"/"25.5" aceitos e serializados com 2 casas — "Modelo de domínio"
- Domínio recebe ids e datas do chamador (não gera UUID nem lê relógio) — "Modelo de domínio"
- `Wallet.open` devolve a wallet (version 1) + lançamento OPENING; saldo inicial zero não gera lançamento; `debit`/`credit` devolvem o lançamento — "Modelo de domínio"
- `markPendingReference(now)` cobre PENDING→PENDING_REFERENCE e as novas tentativas (`referenceAttempts`, `nextReferenceCheckAt`, backoff 5s·2^(n−1) até 10min) — "Modelo de domínio"
- Backoff da outbox determinístico 1s·2^(n−1) até 5min; id da outbox = `eventId` — "Modelo de domínio"
- `FailureCode` com 15 códigos estáveis; erros de domínio não carregam código (o use case da Fase 3 mapeia) — "Taxonomia de failureCode"
- Referência PENDING/PENDING_REFERENCE → aguardar; só referência REJECTED/FAILED gera `REFERENCE_NOT_PROCESSED` — "Taxonomia de failureCode"
- Mapeamento por registros de persistência (`EntitySchema`) + mappers que chamam `rehydrate`; `numeric` como string direto para `Money.from` — "Persistência"
- `WagerTransaction.observedBalance` (coluna `observed_balance`): obrigatório em `markProcessed`, opcional em `reject`; o replay devolve o saldo original — "Persistência"
- Todas as FKs entre tabelas `DEFERRABLE INITIALLY DEFERRED`: a ordem do flush não importa — "Persistência"
- FK `(wallet_id, currency)` da transação via coluna gerada, nula em REJECTED/FAILED (auditar `WALLET_NOT_FOUND`/`CURRENCY_MISMATCH`) — "Persistência"
- Rejeições `REFERENCE_*_MISMATCH` gravam só `reference_external_transaction_id` — "Persistência"
- FKs compostas garantem referência e lançamento na mesma wallet (`uq_wager_tx_id_wallet`) — "Garantias no schema"
- Constraint trigger deferido saldo × último lançamento, nos dois sentidos — "Garantias no schema"
- Triggers: transação nunca é apagada, terminal não muda, identidade/payload imutáveis; ledger append-only (SQLSTATE 23001) — "Garantias no schema"
- TRUNCATE não bloqueado (administrativo; testes usam) — "Persistência"
- Lock pessimista por wallet (`FOR UPDATE` filtrando também `player_id`), `SET LOCAL lock_timeout` 1s com 1 tentativa extra (orçamento ~2s), `version` no UPDATE como segunda barreira; timeout, deadlock e version → `TransientFailure` com log e contador — "Concorrência"
- Idempotência checada sob o lock; `23505` só das constraints esperadas (idempotência, inbox) é relido como replay/conflito; o resto é bug — "Idempotência"
- Idempotency key única por `(provider_id, idempotency_key)` (migration nova) — "Idempotência"
- `payloadHash`: SHA-256 hex do JSON canônico só com campos de negócio; amount normalizado, walletId minúsculo, referência ausente = `null` — "Idempotência"
- Uma reversão no total por transação (índice `ux_wager_tx_one_reversal`); WIN/LOSS sobre BET estornada → `REFERENCE_ALREADY_REVERSED` — "Regras de negócio"
- WIN/LOSS podem referenciar a BET (mesmas validações, sem valor igual); auto-referência e BET com referência → `InvalidInput` — "Regras de negócio"
- Novo `FailureCode` `BALANCE_LIMIT_EXCEEDED` (crédito além do `numeric(20,2)`) — "Taxonomia de failureCode"
- Rejeições no nível da wallet não devolvem saldo — "Taxonomia de failureCode"
- Resultado do use case como união tipada com `status`; `Rejected` cobre REJECTED e FAILED (decidir por `status`) — "Idempotência"
- `causationId`: messageId da inbox ou idempotency key; no `WalletBalanceChanged`, o eventId do `WagerTransactionProcessed` — "Idempotência"
- Ids e textos limitados a 256 caracteres (`InvalidInput`) — "Idempotência"
- Status HTTP: 400/404/409/422/503/500, 503 só para transitório; `FAILED` → 422 — "API HTTP"
- Envelope de erro único `{ error: { code, message } }` via filtro global (inclui erros do Nest; sem mensagens do Postgres) — "API HTTP"
- Abertura de wallet como use case `OpenWallet`; OPENING por factory própria, grava `WalletBalanceChanged` (sem `WagerTransactionProcessed`) — "API HTTP"
- 409 de wallet duplicada devolve o `walletId` existente — "API HTTP"
- `providerId` `internal` e keys `opening:` reservados (400) — "API HTTP"
- Cursor do ledger = base64url de `v1:<seq>`; `limit` 50 / teto 200; `nextCursor` null na última página — "API HTTP"
- Reconciliação num statement, `difference = stored − calculated`, nunca corrige — "API HTTP"
- Autenticação não implementada; `AuthGuard` no-op + desenho com Keycloak client credentials registrado — "Autenticação"
- Logs pino JSON (inclusive logger do Nest); `X-Correlation-Id` aceito só se `^[A-Za-z0-9._:-]{1,128}$` — "Observabilidade"
- Métricas em registry próprio; labels `status`, `kind` (enum ou `UNKNOWN`), `failure_code` — "Observabilidade"
- Consumidor SQS reutiliza o use case instrumentado (`WageringCoreModule`, compartilhado com o HTTP); ligado por `SQS_CONSUMER_ENABLED` — "Consumidor SQS"
- Hash da inbox = SHA-256 do JSON canônico de `{ idempotencyKey, payloadHash }`, com o mesmo hash normalizado da transação; pré-checagem da inbox + releitura no conflito — "Consumidor SQS"
- Classificação: negócio → ack; transitório/bug → retry; envelope/payload inválido e inbox divergente → DLQ com `dlqReason` — "Consumidor SQS"
- Limite 5 no consumidor, redrive 10 na fila; backoff 30/60/120/240 (teto 300s); visibilidade 60s; long polling 20s; pausa do polling até 30s com banco fora — "Consumidor SQS"
- Ordem do grupo preservada sem depender do broker (as seguintes recebem a mesma visibilidade da que falhou) — "Consumidor SQS"
- Shutdown em `beforeApplicationShutdown`, timeout 25s (8s desde a Fase 9), devolve visibilidade 0 do que não terminou — "Consumidor SQS"
- `WagerSettlement` é a fonte única das regras + gravação (use case `insert`, worker `update`) — "Worker de referências pendentes"
- Worker de pendentes: candidatas sem lock; por candidata wallet `SKIP LOCKED` → transação `FOR UPDATE`, relida — "Worker de referências pendentes"
- Expiração por TTL de 1h a partir do `createdAt` (sem limite de tentativas); próxima checagem limitada ao prazo — "Worker de referências pendentes"
- No prazo, referência ausente ou ainda pendente → `REFERENCE_NOT_FOUND` — "Worker de referências pendentes"
- Caminho rápido: transação terminal antecipa as pendentes da mesma wallet que a referenciam (só com a wallet travada) — "Worker de referências pendentes"
- Coluna `correlation_id` imutável; fallback `tx.id`; `causationId` = evento de pendência (fallback `tx.id`) — "Worker de referências pendentes"
- 5 erros inesperados seguidos → FAILED `INFRASTRUCTURE_FAILURE`; 5 `wallet_busy` seguidos → espera o lock; contadores em memória por instância (heurística) — "Worker de referências pendentes"
- `WagerTransactionRejected` aceita FAILED (`failureCode` distingue) — "Worker de referências pendentes"
- Teste multi-instância com processos `bun src/main.ts` reais (não containers), contadores por vida do processo, seed `MULTI_SEED` — "Estratégia de testes"
- `FAULT_INJECTION=exit_after_commit_before_ack` aceita só com `NODE_ENV=test` (lista de permissão) — "Estratégia de testes"
- `sqs_message_acked` só depois do `DeleteMessage` bem-sucedido — "Consumidor SQS"
- Shutdown: os 3 hooks são sequenciais no Nest; padrão 8s cada, soma ≤ `SHUTDOWN_BUDGET_MS` (25s) < `stop_grace_period` (30s), validado no boot — "Estratégia de testes"
- `stop()` do consumidor aborta o long polling (mensagem entregue ao poll abortado volta após a visibilidade) — "Consumidor SQS"
- Docker: imagem `oven/bun:1.4`, profile `multi` com `migrate` + 3 réplicas em `127.0.0.1:3000-3002` — "Estratégia de testes"


## Pendências e limitações
Lista completa em ARCHITECTURE.md → "Limitações"; aqui só o que ficou em aberto.
- Autenticação não implementada; sem vínculo wallet ↔ provider (desenho em ARCHITECTURE.md → "Autenticação").
- O banco não garante que só transação PROCESSED tenha lançamento, nem valor e direção do lançamento = os da transação, nem o encadeamento `balance_before`. O use case garante; a reconciliação detecta, menos o encadeamento lançamento a lançamento.
- `inbox_messages` sem retenção.
- Modo "banco fora": volta a receber até ~5s depois de o banco voltar; várias quedas seguidas podem levar uma mensagem ao `maxReceiveCount` 10 da fila e à DLQ pelo redrive nativo.
- REFUND de BET que já tem WIN PROCESSED é aceito.
- Mensagem cuja primeira entrega termina em `IdempotencyConflict` ou `InvalidInput` não grava inbox (ARCHITECTURE.md → "Limitações").
- `InvalidInput` com código único; rate limit por provider/wallet só na borda; deploy sem permissão de TRUNCATE para o usuário da aplicação.
- O vínculo `SIGTERM` → shutdown hooks foi verificado só manualmente (profile `multi`).
- Limitações do `test:multi`: a sobreposição na hot wallet não é provada; a distribuição da fila entre instâncias depende do broker; a seed reproduz a carga, não a intercalação.

## Registro de sessões
<!-- Data — o que foi feito -->
- 2026-11-07 — Fase 0: projeto Bun + Nest + TS strict, compose (Postgres 16 + LocalStack 4.9.2), filas FIFO + DLQ, MikroORM + migrator, health live/ready.
- 2026-11-07 — Fase 1: `Money` (bigint), `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, inbox/outbox, 4 eventos de integração, `FailureCode`. 160 testes unitários.
- 2026-11-07 — Fase 2: migration com 5 tabelas, CHECKs, UNIQUEs, FKs compostas deferidas, índices parciais, triggers de imutabilidade/append-only e constraint trigger saldo × ledger. 248 testes.
- 2026-11-07 — Fase 3: `ProcessWagerTransaction` (lock pessimista por wallet, idempotência sob lock, regras, outbox/inbox na mesma transação) e 3 migrations novas. 370 testes; concorrência 5× seguidas sem falha.
- 2026-11-07 — Fases 4 e 8: API HTTP (wallets, transações, consultas, ledger paginado, reconciliação, `AuthGuard` no-op), logs JSON e métricas Prometheus; revisão de correção e de interface com 14 ajustes. 437 testes.
- 2026-11-07 — Fase 5: consumidor SQS (inbox, ack após commit, retry com backoff, DLQ com motivo, FIFO por grupo, shutdown gracioso). 483 testes.
- 2026-11-07 — Fase 6: outbox publisher (`SKIP LOCKED`, ordem por agregado via `seq`, backoff sem descarte, timeouts do SQS abaixo do idle timeout). 513 testes.
- 2026-11-07 — Fase 7: `WagerSettlement` como fonte única das regras; worker de referências pendentes (TTL 1h, caminho rápido, FAILED após 5 erros).
- 2026-11-07 — Fase 9: testes multi-instância com processos reais, SIGKILL depois do commit e antes do ack, profile `multi` do compose. 3 rodadas verdes.
- 2026-11-07 — Fase 10: documentação auditada contra o código; README provado num clone limpo.
- 2026-11-08 — Varredura de requisitos (`docs/RASTREABILIDADE.md`) e teste de mutação manual.
- 2026-11-08 — Primeira avaliação independente; correções (reconciliação completa, modo "banco fora", CI, docs); evidência do caos. Tag `v1.0-entrega`.
- 2026-11-08 — Cenário de carga `quente-frias`; mutex local por wallet medido e não adotado.
- 2026-11-08 — Desempate determinístico das pendentes (tag `v1.0.1-entrega`).
- 2026-11-08 — Diário de partidas dobradas: 7 passos, carga A/B, 3 rodadas verdes e CI; mesclado na `main` (tag `v1.1-entrega`).
- 2026-11-08 — Segunda avaliação independente da `v1.1-entrega`; ajustes em `fix/pos-banca`.
