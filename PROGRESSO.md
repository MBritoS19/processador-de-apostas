# Progresso

Legenda: `[ ]` pendente · `[~]` em andamento · `[x]` concluído (com testes passando)

Fase atual: **0 — Setup**

---

## Fase 0 — Setup do projeto
- [ ] Projeto NestJS com Bun e TypeScript strict
- [ ] `docker-compose.yml`: PostgreSQL + LocalStack
- [ ] Criação das filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo`, com redrive policy
- [ ] MikroORM configurado, com migrations rodando (up e down)
- [ ] Scripts do `package.json` batendo com o `CLAUDE.md`
- [ ] `GET /health/live` e `GET /health/ready` (Postgres + SQS)

## Fase 1 — Domínio (CHALLENGE.md §6, §7)
- [ ] `Money`: imutável, escala 2, validação de entradas (NaN, Infinity, notação científica, vazio, mais de 2 casas, negativo)
- [ ] `Money`: conflito de moeda lança erro de domínio
- [ ] `Wallet`: `open`, `rehydrate`, `debit`, `credit`, saldo nunca negativo, `version` incrementa só quando o saldo muda
- [ ] `WagerTransaction`: estados, transições válidas, terminais imutáveis
- [ ] `WalletLedgerEntry`: imutável, `isBalanced` validado na factory
- [ ] `InboxMessage` e `OutboxMessage` (com backoff em `scheduleRetry`)
- [ ] `IntegrationEvent` abstrato + os 4 eventos concretos
- [ ] Taxonomia de `FailureCode` definida
- [ ] Testes unitários de todo o domínio

## Fase 2 — Schema e persistência (§5.9, §6)
- [ ] Tabelas: wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages
- [ ] Constraint: uma wallet por `(player_id, currency)`
- [ ] Constraint: `balance >= 0`
- [ ] Unicidade de `idempotency_key` e de `(provider_id, external_transaction_id)`
- [ ] No máximo um lançamento por `(wallet_id, transaction_id)`
- [ ] CHECK de aritmética do ledger (`balance_before ± money = balance_after`)
- [ ] Trigger que bloqueia UPDATE e DELETE no ledger
- [ ] Uma reversão por referência e por tipo (índice único parcial)
- [ ] Inbox único por `(consumer_name, message_id)`
- [ ] Mapeamento de `Money` ↔ `numeric(20,2)` + `currency`
- [ ] Testes de integração das migrations e das constraints

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

## Pendências e bloqueios

## Registro de sessões
<!-- Data — o que foi feito — próximo passo -->
