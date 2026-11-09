# Rodada final — 2026-11-09

Branch `chore/limpeza` (código de `src/` igual ao da tag `v1.2-entrega`; só docs, comentários, títulos de teste, CI e o profile `demo` do compose mudaram). Postgres 16 + LocalStack 4.9.2 via `docker compose`, Windows 11, Bun 1.4.4, Docker 29.9.2. As saídas brutas ficam fora do git.

## Suítes, 3 rodadas seguidas

| Suíte | Comando | Rodada 1 | Rodada 2 | Rodada 3 |
|---|---|---|---|---|
| Typecheck | `bun run typecheck` | ok (1,6s) | ok (1,3s) | ok (1,2s) |
| Unidade | `bun run test:unit` | 327 pass, 0 fail (4,9s) | 327 pass, 0 fail (4,0s) | 327 pass, 0 fail (4,0s) |
| Integração | `bun run test:integration` | 356 pass, 0 fail (121,0s) | 356 pass, 0 fail (109,4s) | 356 pass, 0 fail (103,8s) |
| Concorrência | `bun run test:concurrency` | 10 pass, 0 fail (12,1s) | 10 pass, 0 fail (11,7s) | 10 pass, 0 fail (11,7s) |
| Multi-instância | `bun run test:multi` | 2 pass, 0 fail (47,1s) | 2 pass, 0 fail (46,8s) | 2 pass, 0 fail (47,4s) |
| Caos | `bun run test:chaos` | 2 pass, 0 fail (83,2s) | 2 pass, 0 fail (83,3s) | 2 pass, 0 fail (83,1s) |

O `test:load` (~11 min) não foi repetido: o código de `src/` é o mesmo da rodada oficial de `docs/CARGA.md` (`1ce388e`).

**Caos (rodada 3), por fase:**

| Fase | Medida |
|---|---|
| Postgres parado | 40,4s parado; 74 requisições HTTP na queda, todas 503 com `Retry-After`; 75 mensagens SQS na queda; 2 entradas e 2 saídas do modo "banco fora"; 2 retries do consumidor; DLQ 0; 150 operações conferidas uma vez |
| LocalStack pausado | 12s pausado; 23 transações HTTP confirmadas na queda; 46 eventos retidos na outbox; 11 falhas de publicação; DLQ 0; 31 operações conferidas uma vez |

## Clone limpo, seguindo só o README

Clone da branch, stack isolada com `-p apostas-clone`.

| Passo | Resultado | Tempo |
|---|---|---|
| `bun install` | ok | 19,1s |
| `cp .env.example .env` | ok | — |
| `docker compose -p apostas-clone up -d --wait` | ok | 11,1s |
| `bun run migration:up` | ok | 0,9s |
| `bun run demo` | `OK: uma PROCESSED, uma REJECTED, saldo 20.00` | 1,2s |
| `bun run typecheck` | ok | 1,3s |
| `bun test` | 695 pass, 13 skip (chaos e load), 0 fail, 708 testes | 162,1s |
| `docker compose -p apostas-clone --profile demo run --rm --build demo` | `OK: uma PROCESSED, uma REJECTED, saldo 20.00` | 7,6s |
| `… --profile demo down` e de novo `… run --rm --build demo` (stack derrubada) | `OK: uma PROCESSED, uma REJECTED, saldo 20.00` | 8,3s |
