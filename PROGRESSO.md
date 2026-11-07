# Progresso

Legenda: `[ ]` pendente · `[~]` em andamento · `[x]` concluído (com testes passando)

Fase atual: **3 — Use case de processamento** (aguardando início)

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
- [ ] `payloadHash` com JSON canônico (algoritmo documentado)
- [ ] Replay idempotente devolve a resposta original, incluindo o saldo daquele momento
- [ ] Mesma key com payload diferente gera conflito
- [ ] Regras de BET, WIN, LOSS, REFUND e ROLLBACK
- [ ] Validação da referência (mesmo provider, player, wallet, moeda e rodada)
- [ ] Reversão que deixaria saldo negativo é rejeitada com `failureCode` próprio
- [ ] Referência ausente vira `PENDING_REFERENCE`
- [ ] Estratégia de concorrência por wallet implementada e documentada
- [ ] Eventos gravados na outbox na mesma transação
- [ ] Cenário obrigatório: saldo 100, duas apostas de 80 → uma PROCESSED, uma REJECTED, saldo 20, um débito

## Fase 4 — API HTTP (§9)
- [ ] `POST /wallets` com transação `OPENING` + lançamento CREDIT na mesma transação
- [ ] Wallet duplicada retorna conflito
- [ ] `POST /wagering/transactions` com `Idempotency-Key` obrigatório
- [ ] Endpoints de consulta (wallet, transação por id, transação por provider + id externo)
- [ ] Ledger com cursor estável e opaco
- [ ] `POST /wallets/:id/reconciliation` (divergência: log + métrica + sinalização na resposta)
- [ ] Mapeamento de status HTTP consistente e documentado
- [ ] Ponto de extensão de autenticação (decisão registrada)

## Fase 5 — Consumidor SQS (§10)
- [ ] Reutiliza o mesmo use case da entrada HTTP
- [ ] Dedup via inbox persistente
- [ ] Ack somente após o commit
- [ ] Classificação de erros: negócio (ack), transitório (retry), permanente (DLQ)
- [ ] Limite de tentativas antes da DLQ
- [ ] Shutdown gracioso no `SIGTERM`

## Fase 6 — Outbox publisher (§11)
- [ ] Worker com `FOR UPDATE SKIP LOCKED` (ou equivalente)
- [ ] Backoff e retry
- [ ] Seguro com múltiplos publishers
- [ ] Publicação duplicada continua segura para o consumidor

## Fase 7 — Worker de referências pendentes (§7.1)
- [ ] Reprocessamento com backoff exponencial
- [ ] Limite de tentativas ou TTL definido e justificado
- [ ] Ao esgotar: `REJECTED` + evento publicado

## Fase 8 — Observabilidade (§12)
- [ ] Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`
- [ ] Métricas: transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência

## Fase 9 — Testes de integração e concorrência (§13)
Integração:
- [ ] Atomicidade entre wallet, ledger, inbox e outbox
- [ ] Inbox e redelivery
- [ ] Retry e DLQ
- [ ] Recuperação após reinicialização

Concorrência (paralelismo real):
- [ ] 1. Mesma aposta 50x em paralelo → um único débito
- [ ] 2. Disputa de saldo na mesma wallet (cenário 80 + 80)
- [ ] 3. Wallets distintas em paralelo
- [ ] 4. 3 ou mais instâncias simultâneas
- [ ] 5. Worker morto depois do commit e antes do ack
- [ ] 6. Dois publishers sobre a mesma outbox
- [ ] 7. ROLLBACK/REFUND entregue antes da referência
- [ ] 8. Reinício do serviço com consistência final comprovada
- [ ] Invariante final em todos: `wallet.balance == saldo reconstruído pelo ledger`

## Fase 10 — Documentação
- [ ] `README.md`: setup e comandos
- [ ] `ARCHITECTURE.md`: ORM, mapeamento de `Money`, estratégia transacional e de concorrência, transições de estado, `failureCode`, status HTTP, algoritmo de hash, TTL das pendências, autenticação, trade-offs e limitações

## Opcionais (só depois de tudo acima)
- [ ] Autenticação com Keycloak ou Zitadel
- [ ] Teste de carga (`bun run test:load`) com p50/p95/p99, erros, conflitos e outbox lag
- [ ] Ledger de partidas dobradas

---

## Decisões tomadas
<!-- Uma linha por decisão; o detalhe vai no ARCHITECTURE.md -->
- MikroORM 6 com `EntitySchema` em infrastructure (domínio sem ORM) — ARCHITECTURE §2
- Migrations em SQL escrito à mão, CLI próprio via `getMigrator()` — §3
- LocalStack fixado em 4.9.2 (sem auth token); MiniStack como alternativa — §4
- Filas FIFO sem dedup por conteúdo; redrive para DLQ com `maxReceiveCount=5` (revisar na Fase 5) — §5
- Liveness não toca dependências; readiness com porta `ReadinessCheck`, 503 e `reason` fechado (timeout|unreachable|error) — §6
- Contexto do ORM explícito em todas as entradas (`allowGlobalContext:false`, `registerRequestContext:false`) — §2
- Conexão preguiçosa no app: sobe com o Postgres fora e reporta not_ready (sem crash loop) — §2
- Módulos Nest por responsabilidade (Config global, Persistence, Messaging, Health) — §1
- `Money` em `bigint` de centavos, escala fixa 2, até 18 dígitos inteiros; "25"/"25.5" aceitos e serializados com 2 casas — §7
- Domínio recebe ids e datas do chamador (não gera UUID nem lê relógio) — §7
- `Wallet.open` devolve a wallet (version 1) + lançamento OPENING; saldo inicial zero não gera lançamento; `debit`/`credit` devolvem o lançamento — §8
- `markPendingReference(now)` cobre PENDING→PENDING_REFERENCE e as novas tentativas (`referenceAttempts`, `nextReferenceCheckAt`, backoff 5s·2^(n−1) até 10min) — §8
- Backoff da outbox determinístico 1s·2^(n−1) até 5min; id da outbox = `eventId` — §8
- `FailureCode` com 14 códigos estáveis; erros de domínio não carregam código (o use case da Fase 3 mapeia) — §9
- Referência PENDING/PENDING_REFERENCE → aguardar; só referência REJECTED/FAILED gera `REFERENCE_NOT_PROCESSED` — §9
- Mapeamento por registros de persistência (`EntitySchema`) + mappers que chamam `rehydrate`; `numeric` como string direto para `Money.from` — §10
- `WagerTransaction.observedBalance` (coluna `observed_balance`): obrigatório em `markProcessed`, opcional em `reject`; o replay devolve o saldo original — §10
- Todas as FKs entre tabelas `DEFERRABLE INITIALLY DEFERRED`: a ordem do flush não importa — §10
- FK `(wallet_id, currency)` da transação via coluna gerada, nula em REJECTED/FAILED (auditar `WALLET_NOT_FOUND`/`CURRENCY_MISMATCH`) — §10
- Rejeições `REFERENCE_*_MISMATCH` gravam só `reference_external_transaction_id` — §10
- FKs compostas garantem referência e lançamento na mesma wallet (`uq_wager_tx_id_wallet`) — §11
- Constraint trigger deferido saldo × último lançamento, nos dois sentidos — §11
- Triggers: transação nunca é apagada, terminal não muda, identidade/payload imutáveis; ledger append-only (SQLSTATE 23001) — §11
- TRUNCATE não bloqueado (administrativo; testes usam) — §10

## Pendências e bloqueios
- `README.md` fica para a Fase 10; por ora os comandos estão só no CLAUDE.md, que é local (fora do git).
- Fase 9: remover `--pass-with-no-tests` do `test:concurrency` quando o primeiro teste de concorrência existir.
- Fase 4: `OPENING` ainda não tem factory própria (`WagerTransaction.create` a rejeita); criar junto com `POST /wallets`.
- Fase 7: definir limite de tentativas/TTL de `PENDING_REFERENCE` (o backoff já está no domínio).
- Fase 3: repositórios aplicam o estado do domínio no registro gerenciado (o UoW não rastreia o objeto de domínio); traduzir `23505` de idempotência em replay/conflito.
- Fase 3: o banco não garante que só transação PROCESSED tenha lançamento, nem valor do lançamento = valor da transação, nem o encadeamento `balance_before` do lançamento anterior (limitações em ARCHITECTURE §11).
- Fase 4: cursor do ledger usa `seq` (não mapeado no registro; ler na consulta paginada).
- Deploy: usuário da aplicação sem permissão de TRUNCATE.

## Registro de sessões
<!-- Data — o que foi feito — próximo passo -->
- 2026-11-07 — Fase 0 concluída: projeto Bun+Nest+TS strict, compose (Postgres 16 + LocalStack 4.9.2), filas FIFO + DLQ, MikroORM + migrator, health live/ready. 21 testes passando (12 unit, 9 integração). — Próximo: Fase 1 (domínio), aguardando aprovação do plano.
- 2026-11-07 — Revisão (6 revisores) da Fase 0: 2 médios + 13 baixos corrigidos (reason do readiness fechado e sem vazamento, nome de migration validado, CLI valida args antes de conectar, .env.test autossuficiente, portas em loopback, healthcheck do LocalStack checa falha de script, módulos Nest, boot tolerante a Postgres fora). 64 testes passando (44 unit, 20 integração). — Próximo: Fase 1.
- 2026-11-07 — Fase 1 concluída: Money (bigint), Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, 4 eventos de integração, FailureCode; ARCHITECTURE §7–9. 160 testes unitários passando (116 do domínio). — Próximo: Fase 2 (schema), aguardando plano.
- 2026-11-07 — Fase 2 concluída: migration com 5 tabelas, CHECKs, UNIQUEs, FKs compostas deferidas, índices parciais, triggers de imutabilidade/append-only e constraint trigger saldo × ledger; mapeamento EntitySchema + mappers; ARCHITECTURE §10–11. 248 testes passando (162 unit, 86 integração). — Próximo: Fase 3 (use case), aguardando plano.
