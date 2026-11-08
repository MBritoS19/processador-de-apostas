# Progresso

Legenda: `[ ]` pendente · `[~]` em andamento · `[x]` concluído (com testes passando)

Fase atual: **Concluído — opcionais** (Fases 0–10 concluídas em 2026-11-07)

---

## Fase 0 — Setup do projeto
- [x] Projeto NestJS com Bun e TypeScript strict
- [x] `docker-compose.yml`: PostgreSQL + LocalStack
- [x] Criação das filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo`, com redrive policy
- [x] MikroORM configurado, com migrations rodando (up e down)
- [x] Scripts do `package.json` batendo com o `CLAUDE.md`
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
- [x] Uma reversão por referência e por tipo (índice único parcial)
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

## Correções da banca avaliadora (2026-11-08)
- [x] Lote 1: `main` verde (`test:load` no contrato de scripts), CI em `.github/workflows/ci.yml` (typecheck + unit; integração com o próprio compose), README (nome fixo do projeto no compose, aplicação de pé nos testes, seed fixa do multi, tempos, Estrutura), ARCHITECTURE (seed, CI, retenção da inbox, replay de FAILED)
- [x] Lote 2: reconciliação como use case (`ReconcileWallet`), cruzando ledger × transações (7 tipos de divergência, um teste de integração por tipo); consumidor com modo "banco fora" (só erro de conexão; para de receber e sonda o Postgres; mensagem fora do limite de tentativas; gauge `wagering_consumer_db_unavailable`); pool esgotado separado (`pool_exhausted`); `test:chaos` com o Postgres parado 40s
- [x] Lote 3: 80+80 com sobreposição provada e reenvio; BET sem referência e "não referencia a si mesma" em `WagerTransaction.create`; leitura de idempotência sem lock antes do caminho com lock; hash da inbox normalizado; 1 tentativa extra interna em `lock_timeout`
- [x] Evidência do `test:chaos` em `docs/carga/chaos.txt`
- [x] Ajustes finais: orçamento de espera pelo lock mantido em ~2s (2 tentativas de 1s); sonda do modo "banco fora" com teto de 5s

## Fechamento
- [x] Banca avaliadora (~82/100, nenhuma eliminatória; relatório local em `banca/`)
- [x] Correções da banca (lotes 1 a 3 e ajustes finais)
- [x] Comentários de "porquê" nos 10–15 pontos críticos, com referência à spec (commit `90ad45e`)
- [x] Checklist de entrega (2026-11-08): `.env` e `CLAUDE.md` fora do git; clone limpo do remoto seguindo só o README (compose isolado, install, migration:up, `bun test`: 611 pass, 13 skip, 0 fail); README completado (URL real, `skip` explicado, demo); push junto com este fechamento
- [ ] Preparação da apresentação
- [x] Rodada final (2026-11-08), resumo em `docs/carga/final/RESUMO.md`: typecheck ok, unit 296, integração 304 (3 rodadas seguidas, 0 falha), concorrência 9, multi 2, chaos 2 (Postgres parado 40s: 2 entradas e 2 saídas do modo "banco fora", DLQ 0; LocalStack pausado 12s: 46 eventos retidos na outbox, DLQ 0)
- [x] `bun run demo`: cenário obrigatório (saldo 100, duas BETs de 80 em paralelo → uma PROCESSED, uma REJECTED `INSUFFICIENT_BALANCE`, saldo 20, reconciliação consistente)
- [x] README: badge de CI e diagrama Mermaid do fluxo; ARCHITECTURE.md → "Evolução futura" (partidas dobradas, onde entra o `AuthGuard`, limitações e o que fecharia cada uma)
- [x] Ledger de partidas dobradas: planejado em etapas (diário paralelo e aditivo) em ARCHITECTURE.md → "Evolução futura"; não implementado
- [x] Mutex local por wallet: implementado no branch `feat/mutex-local` (não mesclado) e medido com o cenário `quente-frias` (3 rodadas antes + 3 depois, alternadas). Frias p95 −96%, mas quente PROCESSED/s −47% e 503 de 0 para 40: critério de merge não atingido. Resultado em `docs/CARGA.md` → "Mutex local por wallet: medido, não adotado"; JSONs em `docs/carga/mutex/`

## Opcionais (só depois de tudo acima)
- [ ] Autenticação com Keycloak ou Zitadel — não implementada por decisão: não vale pontos (CHALLENGE §2, "Autenticação — a cargo do candidato"); `AuthGuard` no-op e desenho (Keycloak client credentials, vínculo `wallet_providers`) documentados em ARCHITECTURE.md → "Autenticação"
- [x] Teste de carga (`bun run test:load`) com p50/p95/p99, erros, conflitos e outbox lag (concluído em 2026-11-08; metodologia em ARCHITECTURE.md → "Estratégia de testes"; análise do outbox lag e do acúmulo na fila, com propostas não implementadas, em `docs/CARGA.md`; dados em `docs/carga/`)
- [ ] Ledger de partidas dobradas (plano em ARCHITECTURE.md → "Evolução futura"; em andamento, ver abaixo)

## Diário de partidas dobradas (branch `feat/partidas-dobradas`, 2026-11-08)
Plano aprovado. Prazo: passos 1–6 até 2026-11-09 15h; passo 7 até 18h; estourando, para no último passo verde. Critério de merge: todas as suítes verdes 3× e p95 de `quente-frias` até +20% sobre a main, sem erros novos; fora disso, não mescla e registra o resultado no ARCHITECTURE.md. Um commit e um push por passo; a main não é tocada.
- [x] 1. Domínio: `JournalEntry` (débito = crédito, uma moeda, ≥ 2 pernas, imutável) e `forTransaction` (perna PLAYER com a direção do lançamento da wallet; contrapartida FUNDING no OPENING, PROVIDER_HOUSE do provider nos demais). Unit 319
- [x] 2. Migration `…20261109000000_double_entry_journal`: `accounts`, `journal_entries`, `journal_postings`; append-only (23001); constraint trigger deferido `trg_journal_balanced` (23514: débito = crédito, transação PROCESSED que move saldo, contas certas, perna PLAYER = lançamento da wallet); FUNDING para BRL, USD e moedas existentes (moeda nova: sob demanda, decisão do autor); backfill do ledger; `down` remove só o diário. `bun test`: 670 pass, 13 skip, 0 fail
- [x] 3. Persistência: porta `insertJournalEntry` e adaptador em SQL direto (`journal.persistence.ts`; sem EntitySchema, porque nada do diário é lido pelo ORM): contas pela chave natural numa consulta (índices parciais), as que faltam com `on conflict do nothing` + releitura; lançamento e pernas num statement. Testes: primeiro uso concorrente de HOUSE (espera e reaproveita; holder desiste → cria a própria), FUNDING sob demanda, diário desbalanceado derruba a transação inteira. `bun test`: 675 pass, 13 skip, 0 fail
- [ ] 4. Gravação dupla em `WagerSettlement` e `OpenWallet`; atomicidade; erro do diário (23514) permanente no consumidor SQS (DLQ direto)
- [ ] 5. Reconciliação: `JOURNAL_BALANCE_MISMATCH` e `journalBalance`
- [ ] 6. Concorrência e multi: saldo PLAYER = `wallets.balance` = ledger
- [ ] 7. Carga A/B `quente-frias` e documentação (ledger → diário no schema vai para "Evolução futura")

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
- `FailureCode` com 14 códigos estáveis; erros de domínio não carregam código (o use case da Fase 3 mapeia) — "Taxonomia de failureCode"
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
- Lock pessimista por wallet (`FOR UPDATE` filtrando também `player_id`), `SET LOCAL lock_timeout` 2s, `version` no UPDATE como segunda barreira; timeout, deadlock e version → `TransientFailure` com log e contador — "Concorrência"
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
- Hash da inbox = SHA-256 do JSON canônico de `{ type, data }` (sem messageId/occurredAt); pré-checagem da inbox + releitura no conflito — "Consumidor SQS"
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

## Pendências e bloqueios
- Limitação: o banco não garante que só transação PROCESSED tenha lançamento, nem valor e direção do lançamento = os da transação, nem o encadeamento `balance_before` (ARCHITECTURE.md → "Limitações"). O use case garante, e `expectLedgerConsistent` verifica nos testes. Em produção, a reconciliação (refeita na banca) detecta tudo isso, menos o encadeamento lançamento a lançamento (ARCHITECTURE.md → "Reconciliação").
- Limitação: `inbox_messages` não tem retenção (ARCHITECTURE.md → "Idempotência").
- Limitação: o modo "banco fora" volta a receber até ~5s depois de o banco voltar (teto da sonda); com várias quedas seguidas, a mensagem pode chegar ao `maxReceiveCount` 10 da fila e ir para a DLQ pelo redrive nativo, sem motivo (ARCHITECTURE.md → "Modo \"banco fora\"").
- Decisão pendente: amarrar `payload.providerId` ao provider autenticado e escopar as consultas por provider (desenho em ARCHITECTURE.md → "Autenticação"). Sem isso, qualquer cliente submete em nome de qualquer provider e lê transações e saldos alheios.
- Limitação: wallets não têm vínculo com provider; qualquer provider que conheça `walletId` + `playerId` movimenta a wallet. O vínculo (`wallet_providers`) está no desenho de ARCHITECTURE.md → "Autenticação", não implementado.
- Lock da wallet antes da checagem de dono: resolvido na Fase 3 (`FOR UPDATE ... AND player_id`); rate limit por provider/wallet na borda continua recomendado.
- `InvalidInput` tem código único (`INVALID_INPUT`) e motivo em texto; códigos por campo ficam para quando um consumidor precisar.
- Limitação conhecida: REFUND de BET que já tem WIN PROCESSED é aceito (ARCHITECTURE.md → "Regras de negócio").
- Deploy: usuário da aplicação sem permissão de TRUNCATE.
- Resolvido (Fase 9): `stop_grace_period: 30s` no serviço `app` do profile `multi`, com a soma dos prazos de shutdown validada no boot (ARCHITECTURE.md → "Estratégia de testes").
- Limitação (C4a, ARCHITECTURE.md → "Consumidor SQS"): se a primeira entrega de um `messageId` termina em `IdempotencyConflict` ou `InvalidInput`, a inbox não é gravada; o mesmo `messageId` com outro payload válido depois é processado. Fechar exige mudar o use case.
- O vínculo `SIGTERM` → shutdown hooks (`enableShutdownHooks`) não tem teste automatizado (os testes usam `app.close()`); verificado manualmente no `down` do profile `multi` (3 réplicas, saída 0, sem timeout).
- Limitações do `test:multi` (ARCHITECTURE.md → "Estratégia de testes"): a sobreposição na hot wallet não é provada; "pegou trabalho em andamento" no item 8 é sanidade; a distribuição da fila entre instâncias depende do broker; a seed reproduz a carga, não a intercalação.

## Registro de sessões
<!-- Data — o que foi feito — próximo passo -->
- 2026-11-07 — Fase 0 concluída: projeto Bun+Nest+TS strict, compose (Postgres 16 + LocalStack 4.9.2), filas FIFO + DLQ, MikroORM + migrator, health live/ready. 21 testes passando (12 unit, 9 integração). — Próximo: Fase 1 (domínio), aguardando aprovação do plano.
- 2026-11-07 — Revisão (6 revisores) da Fase 0: 2 médios + 13 baixos corrigidos (reason do readiness fechado e sem vazamento, nome de migration validado, CLI valida args antes de conectar, .env.test autossuficiente, portas em loopback, healthcheck do LocalStack checa falha de script, módulos Nest, boot tolerante a Postgres fora). 64 testes passando (44 unit, 20 integração). — Próximo: Fase 1.
- 2026-11-07 — Fase 1 concluída: Money (bigint), Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, 4 eventos de integração, FailureCode; ARCHITECTURE §7–9. 160 testes unitários passando (116 do domínio). — Próximo: Fase 2 (schema), aguardando plano.
- 2026-11-07 — Fase 2 concluída: migration com 5 tabelas, CHECKs, UNIQUEs, FKs compostas deferidas, índices parciais, triggers de imutabilidade/append-only e constraint trigger saldo × ledger; mapeamento EntitySchema + mappers; ARCHITECTURE §10–11. 248 testes passando (162 unit, 86 integração). — Próximo: Fase 3 (use case), aguardando plano.
- 2026-11-07 — Fase 3 concluída: use case `ProcessWagerTransaction` (lock pessimista por wallet, idempotência sob lock, regras §7, outbox/inbox na mesma transação), 3 migrations novas (uma reversão no total, idempotência por provider, `BALANCE_LIMIT_EXCEEDED`); revisão com 6 revisores (5 médios + lows corrigidos); ARCHITECTURE §12–15. 370 testes passando (210 unit, 156 integração, 4 concorrência — este 5x seguidas sem falha). — Próximo: Fase 4 (API HTTP), aguardando plano.
- 2026-11-07 — Fase 4 concluída: API HTTP de wallets, transações, consultas, ledger paginado, reconciliação e AuthGuard no-op; status HTTP documentados em ARCHITECTURE §16. Typecheck e testes HTTP de integração passando. — Próximo: Fase 5 (SQS), aguardando plano.
- 2026-11-07 — Fase 8 parcial concluída: logs JSON com correlação HTTP, métricas Prometheus em registry próprio e wrapper compartilhado do use case; retries/DLQ/outbox lag apenas declaradas para as Fases 5–7. — Próximo: Fase 5 (SQS), aguardando plano.
- 2026-11-07 — Validação das Fases 4 e 8 (implementadas pelo Copilot; revisores correctness + interface): 14 achados corrigidos (erros do banco viravam 400, id não-UUID dava 500, FAILED em 503, label `kind` sem limite, reconciliação sem métrica, OPENING sem evento, envelope de erro, nomes reservados, cursor, correlationId, wrapper, convenções Prometheus, 202/409). Novo use case `OpenWallet`, factory `WagerTransaction.opening`, filtro global; ARCHITECTURE §16–17 reescritos. 437 testes passando (240 unit, 193 integração, 4 concorrência). — Próximo: Fase 5 (SQS), aguardando plano.
- 2026-11-07 — Fase 5 concluída: consumidor SQS (inbox, ack após commit, retry com backoff, DLQ com motivo, FIFO por grupo, pausa do polling com banco fora, shutdown gracioso), `WageringCoreModule` compartilhado; revisão (correctness + test-evidence): 6 achados de código e 10 de testes corrigidos (redrive 10 / limite 5, ordem do grupo sem depender do broker, releitura da inbox, envelope ilegível → DLQ, loop único). ARCHITECTURE §18. 483 testes passando (259 unit, 220 integração, 4 concorrência). — Próximo: Fase 6 (outbox publisher), aguardando plano.
- 2026-11-07 — Fase 6 concluída: outbox publisher em `wager-events.fifo` (claim com `FOR UPDATE SKIP LOCKED` publicando ainda com o lock, ordem por agregado via `seq`, `SendMessageBatch` com falha por entrada, backoff sem descarte nem DLQ, timeouts do SQS abaixo do idle timeout, métricas published/failures/retries/stuck e outbox lag, shutdown gracioso). Revisão (correctness + test-evidence): 4 achados de código e 14 de testes corrigidos (backfill ordenado do `seq`, reenvio um a um em 4xx, SDK sem retries + folga de 2s, falha parcial real do LocalStack, `pg_terminate_backend`, idle timeout, shutdown com timeout). ARCHITECTURE §19. 513 testes passando (263 unit, 244 integração, 6 concorrência). Observação: uma execução da integração travou uma vez sem atividade no banco e não se repetiu em duas execuções seguidas. — Próximo: Fase 7 (referências pendentes), aguardando plano.
- 2026-11-07 — Fase 7 concluída: `WagerSettlement` extraído (commit próprio), worker de referências pendentes (SKIP LOCKED na wallet, TTL 1h, caminho rápido, `correlation_id`, FAILED após 5 erros, espera do lock após 5 `wallet_busy`), métricas e flag. Corrigido o travamento intermitente da suíte de integração (`killClaimSession` agora espera o término do backend). Revisão (correctness + test-evidence): 3 achados de código e 12 de testes corrigidos. ARCHITECTURE §20. — Próximo: Fase 9 (testes de integração e concorrência), aguardando plano.
- 2026-11-07 — Fase 9 validada e concluída (feita no Antigravity, revisada aqui com test-evidence + correctness): 5 achados apontados e 7 novos corrigidos (50 envios em paralelo HTTP+SQS nas 3 instâncias, prova de tráfego por instância antes e depois do reinício, contadores por vida do processo, ack logado só após o DeleteMessage, atomicidade da resolução pelo worker, checagens transação → evento, ledger no wagering-http/outbox, FAULT_INJECTION só com NODE_ENV=test, shutdown 8s ×3 com orçamento de 25s validado no boot, abort do long polling). Docker: build, profile multi com 3 réplicas ready, StopTimeout=30, down gracioso (saída 0, ~4s). 3 rodadas seguidas verdes: unit 281 (~4s), integração 282 (~57s), concorrência 8 (~8s), multi 1 (~40s). ARCHITECTURE §21 e README. — Próximo: Fase 10 (documentação), aguardando plano.
- 2026-11-07 — Fase 10 concluída: auditoria da documentação contra o código (variáveis, scripts, failureCodes, métricas e números batendo); ARCHITECTURE.md reorganizado por tema e sem números de seção (índice, visão geral em 1 minuto, estratégia transacional, configuração, interpretações, decisões/trade-offs/limitações); desenho de autenticação com leitura de wallet/ledger e vínculo `wallet_providers` (AuthGuard segue no-op); citações "§N" trocadas pelo nome da seção no código, nas configs e nas listas acima (este registro mantém os números antigos); README reescrito e provado num clone limpo com compose isolado (install, up, migrations, unit 281, integração 282, exemplos curl). Typecheck e unit verdes no repositório. — Próximo: opcionais, só com pedido.
- 2026-11-08 — Banca avaliadora (clone limpo do GitHub, um subagente por área da §14 do CHALLENGE + eliminatórias): nota estimada ~82/100, nenhuma falha eliminatória; relatório local em `banca/` (fora do git). Correções em 3 lotes e 4 commits (main verde + CI + docs; reconciliação completa + consumidor resiliente a queda do banco; ajustes de custo baixo; evidências). Fechamento: typecheck ok, unit 295, integração 304, concorrência 9, multi 2, chaos 2 (Postgres parado 40s: 2 entradas e 2 saídas do modo "banco fora", 2 retries, DLQ 0; saída em `docs/carga/chaos.txt`). — Próximo: revisão e push pelo autor.
- 2026-11-08 — Fechamento: itens registrados no PROGRESSO; cenário de carga `quente-frias` (50 clientes numa wallet + 10 em 300 wallets, medido por grupo). Mutex local por wallet implementado em `feat/mutex-local` (unit 309, integração 304 em 3 de 4 rodadas (1 falha intermitente não identificada), concorrência 9, multi 2) e medido A/B alternado 3×3: frias p95 2.148→88ms, mas quente 55,7→29,3 PROCESSED/s e 0→40 respostas 503; não mesclado, documentado em docs/CARGA.md e ARCHITECTURE.md. — Próximo: comentários de "porquê" nos pontos críticos.
- 2026-11-08 — Fechamento final da main: rodada completa com resumo em `docs/carga/final/RESUMO.md` (unit 296, integração 304 ×3, concorrência 9, multi 2, chaos 2, tudo verde); clone limpo do remoto pelo README (611 pass, 13 skip); `bun run demo`; ARCHITECTURE.md → "Evolução futura"; README com badge de CI, Mermaid e lacunas do clone corrigidas. — Próximo: preparação da apresentação.
