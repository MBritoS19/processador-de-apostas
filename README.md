# Processador de Apostas

Serviço que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) recebidas de provedores por HTTP e SQS. Saldo, ledger, inbox e outbox são gravados na mesma transação, e funciona com várias instâncias em paralelo.

- Especificação: [`CHALLENGE.md`](CHALLENGE.md)
- Decisões, trade-offs e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Andamento: [`PROGRESSO.md`](PROGRESSO.md)

## Requisitos

- [Bun](https://bun.sh) 1.4 ou mais recente
- Docker com Compose v2

## Setup

```bash
docker compose up -d --wait       # Postgres 16 + LocalStack (as filas são criadas no init)
bun install
cp .env.example .env              # só na primeira vez
bun run migration:up
bun run start:dev                 # API + consumidor SQS + outbox publisher + worker de pendentes (watch)
```

A API sobe em `http://localhost:3000`. Para checar: `GET /health/live` e `GET /health/ready`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` / `bun run start:dev` | sobe a aplicação (sem e com watch) |
| `bun run migration:up` | aplica as migrations pendentes |
| `bun run migration:down` | reverte a última migration (`-- --all` reverte todas) |
| `bun run migration:pending` | lista as pendentes |
| `bun run migration:create -- <nome>` | cria uma migration |
| `bun run typecheck` | `tsc --noEmit` (o Bun não checa tipos) |

## Testes

Todas as suítes, exceto a de unidade, usam Postgres e LocalStack **reais** (`docker compose up -d --wait` antes). Rodam no banco `wagering_test`, configurado em `.env.test`, que o `bun test` carrega sozinho com `NODE_ENV=test`. Não rode duas suítes ao mesmo tempo: elas compartilham esse banco.

| Comando | Suíte | Tempo típico |
|---|---|---|
| `bun run test:unit` | domínio, regras e config, sem I/O | ~5s |
| `bun run test:integration` | migrations, constraints, atomicidade, inbox/redelivery, retry/DLQ, outbox, recuperação | ~1 min |
| `bun run test:concurrency` | paralelismo real num processo (80+80, mesma BET 50x, publishers e workers concorrentes) | ~10s |
| `bun run test:multi` | 3 processos reais da aplicação + SIGKILL depois do commit e antes do ack + SIGKILL de todas no meio da carga | ~40s |
| `bun test` | todas as suítes acima | |

O `test:multi` sobe processos `bun src/main.ts` locais (não containers), cada um com API, consumidor, publisher e worker. A carga é gerada por uma seed fixa, impressa no início e na falha. Para reproduzir a carga de uma execução:

```bash
MULTI_SEED=<n> bun run test:multi
```

O que cada suíte prova, como funciona a injeção de falha (`FAULT_INJECTION`, aceita só com `NODE_ENV=test`) e as limitações estão no `ARCHITECTURE.md` §21.

## Várias instâncias com Docker (profile `multi`)

Para subir 3 réplicas da imagem sobre o mesmo Postgres e LocalStack:

```bash
docker compose --profile multi up -d --build --wait   # migrate + 3 réplicas em 127.0.0.1:3000-3002
curl http://127.0.0.1:3000/health/ready               # idem nas portas 3001 e 3002
docker compose --profile multi down
```

- O serviço `migrate` aplica as migrations antes de as réplicas subirem.
- As réplicas rodam com `NODE_ENV=production`, e a injeção de falha é recusada.
- `stop_grace_period: 30s`: o `SIGTERM` do `down` dispara o shutdown gracioso. A soma dos três prazos de shutdown (8s cada) precisa caber em `SHUTDOWN_BUDGET_MS` (25s); se não couber, a aplicação não sobe (`ARCHITECTURE.md` §21).
- O `docker compose --profile multi down` também derruba o Postgres e o LocalStack do compose. Os dados do Postgres ficam no volume.
