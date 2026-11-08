# Rodada final — 2026-11-08

Commit base `90ad45e`, Postgres 16 + LocalStack 4.9.2 via `docker compose`, Windows 11, Bun 1.4.4. As saídas brutas ficam fora do git.

| Suíte | Comando | Resultado | Tempo |
|---|---|---|---|
| Typecheck | `bun run typecheck` | ok | — |
| Unidade | `bun run test:unit` | 296 pass, 0 fail | 4,1s |
| Integração (1ª) | `bun run test:integration` | 304 pass, 0 fail | 86,5s |
| Integração (2ª) | `bun run test:integration` | 304 pass, 0 fail | 84,9s |
| Integração (3ª) | `bun run test:integration` | 304 pass, 0 fail | 82,9s |
| Concorrência | `bun run test:concurrency` | 9 pass, 0 fail | 9,5s |
| Multi-instância | `bun run test:multi` | 2 pass, 0 fail | 45,2s |
| Caos | `bun run test:chaos` | 2 pass, 0 fail | 83,0s |
| Demo | `bun run demo` | 1 PROCESSED, 1 REJECTED (`INSUFFICIENT_BALANCE`), saldo 20.00, reconciliação consistente | — |
| Clone limpo do remoto (só o README) | `bun test` | 611 pass, 13 skip (chaos e load), 0 fail | 139,3s |

**Caos, por fase:**

| Fase | Medida |
|---|---|
| Postgres parado | 40,1s parado; 73 requisições HTTP na queda, todas 503 com `Retry-After`; 74 mensagens SQS na queda; 2 entradas e 2 saídas do modo "banco fora"; 2 retries do consumidor; DLQ 0; 148 operações conferidas uma vez |
| LocalStack pausado | 12s pausado; 23 transações HTTP confirmadas na queda; 46 eventos retidos na outbox; 11 falhas de publicação; DLQ 0; 31 operações conferidas uma vez |
