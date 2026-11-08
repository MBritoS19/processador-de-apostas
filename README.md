# Processador de Apostas

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de provedores por HTTP e por SQS. Saldo, ledger, inbox e outbox são gravados na mesma transação SQL, os eventos saem depois do commit por um outbox publisher, e o serviço funciona com várias instâncias em paralelo.

- Especificação: [`CHALLENGE.md`](CHALLENGE.md)
- Arquitetura, decisões, trade-offs e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md) (comece pela "Visão geral em 1 minuto")
- Andamento por fase: [`PROGRESSO.md`](PROGRESSO.md)

Stack: Bun 1.x, TypeScript estrito, NestJS, PostgreSQL 16 com MikroORM 6, AWS SQS via LocalStack e Docker Compose.

## Pré-requisitos

- [Bun](https://bun.sh) 1.4 ou mais recente (`bun --version`)
- Docker com Compose v2 (`docker compose version`)
- Git
- Portas livres em `127.0.0.1`: `5432` (Postgres), `4566` (LocalStack) e `3000` (API)

**Windows:** o projeto roda nativamente (Bun para Windows e Docker Desktop); foi desenvolvido e testado assim. Os comandos abaixo funcionam no PowerShell, no Git Bash e no WSL, com duas exceções no PowerShell, indicadas onde aparecem: copiar o `.env` e definir variável de ambiente na linha de comando. O repositório força LF (`.gitattributes`), então o script de init do LocalStack funciona mesmo com `core.autocrlf=true`.

## Setup do zero

```bash
git clone <url-do-repositório> processador-de-apostas
cd processador-de-apostas
bun install
cp .env.example .env                  # PowerShell: Copy-Item .env.example .env
docker compose up -d --wait           # Postgres 16 + LocalStack; espera os healthchecks (as filas são criadas no init)
bun run migration:up                  # aplica as migrations no banco de desenvolvimento
```

O `--wait` só volta quando o Postgres aceita conexões e o script de criação das filas terminou com sucesso. O banco de testes `wagering_test` é criado pelo init do Postgres, e as suítes aplicam as migrations nele sozinhas.

## Rodar a API e os workers

```bash
bun run start:dev                     # com watch
bun run start                         # sem watch
```

Um único processo sobe a API HTTP em `http://localhost:3000` e os três loops de fundo: consumidor SQS, outbox publisher e worker de referências pendentes. Cada loop pode ser desligado no `.env` (`SQS_CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `PENDING_REFERENCE_WORKER_ENABLED`). Para rodar várias instâncias localmente, suba outros processos com `HTTP_PORT` diferente; todas compartilham o mesmo Postgres e as mesmas filas.

Para conferir:

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready     # 200 com Postgres e SQS alcançáveis, 503 caso contrário
curl http://localhost:3000/metrics          # métricas Prometheus
```

Exemplo de uso (no PowerShell, use `curl.exe` e aspas duplas escapadas, ou um cliente HTTP):

```bash
curl -s -X POST http://localhost:3000/wallets -H 'Content-Type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
# → 201 { "id": "<walletId>", ... }

curl -s -X POST http://localhost:3000/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1","walletId":"<walletId>","roundId":"r-1","gameId":"g-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# → 200 { "transactionId": "...", "status": "PROCESSED", "balance": { "amount": "75.00", ... }, "idempotentReplay": false }
```

Endpoints e status HTTP: `ARCHITECTURE.md` → "API HTTP". A autenticação não está implementada (desenho em `ARCHITECTURE.md` → "Autenticação").

## Testes

Todas as suítes, exceto a de unidade, usam Postgres e LocalStack **reais**: rode `docker compose up -d --wait` antes. Elas usam o banco `wagering_test`, configurado em `.env.test`, que o `bun test` carrega sozinho (com `NODE_ENV=test`); não dependem do seu `.env`. Não rode duas suítes ao mesmo tempo: elas compartilham esse banco.

| Comando | Suíte | Tempo típico |
|---|---|---|
| `bun run typecheck` | `tsc --noEmit` (o Bun não checa tipos) | ~2s |
| `bun run test:unit` | domínio, regras e config, sem I/O | ~5s |
| `bun run test:integration` | migrations, constraints, atomicidade, inbox e redelivery, retry e DLQ, outbox, recuperação | ~1 min |
| `bun run test:concurrency` | paralelismo real num processo (80+80, a mesma BET 50x, publishers e workers concorrentes) | ~10s |
| `bun run test:multi` | 3 processos reais da aplicação, SIGKILL depois do commit e antes do ack, SIGKILL de todas no meio da carga | ~40s |
| `bun test` | todas as suítes acima | ~2 min |
| `bun run test:chaos` | **para o Postgres e pausa o LocalStack** (~12s cada) com 2 processos sob carga; fora do `bun test` (só roda com `CHAOS=1`, que o script define) | ~40s |
| `bun run test:load` | teste de carga: 3 instâncias, 3 cenários × níveis `10,50` (`LOAD_LEVELS=10,50,100` opcional, ~15 min), consistência ao fim de cada rodada; resumo no terminal e JSON em `test/load/results/`; fora do `bun test` (só com `LOAD=1`) | ~10 min |

O `test:chaos` mexe nos containers compartilhados do `docker compose` (`stop`/`start` do Postgres, `pause`/`unpause` do LocalStack) e os restaura no fim, mesmo se falhar. Não rode outra suíte junto.

A matriz que liga cada exigência do `CHALLENGE.md` ao teste que a prova, e o teste de mutação, estão em [`docs/RASTREABILIDADE.md`](docs/RASTREABILIDADE.md).

O `test:multi` sobe processos `bun src/main.ts` locais (não containers), em portas livres escolhidas na hora, cada um com API, consumidor, publisher e worker. A carga é gerada por uma seed, impressa no início e na falha. Para reproduzir a carga de uma execução:

```bash
MULTI_SEED=<n> bun run test:multi     # PowerShell: $env:MULTI_SEED=<n>; bun run test:multi
```

O que cada suíte prova, a injeção de falha (`FAULT_INJECTION`, aceita só com `NODE_ENV=test`) e as limitações dos testes estão em `ARCHITECTURE.md` → "Estratégia de testes".

## Várias instâncias com Docker (profile `multi`)

Sobe 3 réplicas da imagem sobre o mesmo Postgres e LocalStack:

```bash
docker compose --profile multi up -d --build --wait   # migrate + 3 réplicas em 127.0.0.1:3000-3002
curl http://127.0.0.1:3000/health/ready               # idem nas portas 3001 e 3002
docker compose --profile multi down
```

- A porta 3000 precisa estar livre: pare o `bun run start:dev` antes.
- O serviço `migrate` aplica as migrations antes de as réplicas subirem.
- As réplicas rodam com `NODE_ENV=production`, e a injeção de falha é recusada.
- `stop_grace_period: 30s`: o `SIGTERM` do `down` dispara o shutdown gracioso. A soma dos três prazos de shutdown (8s cada) precisa caber em `SHUTDOWN_BUDGET_MS` (25s); se não couber, a aplicação não sobe.

## Desligar a infraestrutura

```bash
docker compose down        # para e remove os containers; os dados do Postgres ficam no volume
docker compose down -v     # ⚠ também APAGA o volume: todos os dados do Postgres (dev e testes) são perdidos
```

Para só desligar, use `down` **sem** `-v`. Use `-v` apenas quando quiser recomeçar do zero; depois dele, rode de novo `docker compose up -d --wait` e `bun run migration:up`. O LocalStack não persiste estado: as filas são recriadas a cada `up`.

## Migrations

| Comando | O que faz |
|---|---|
| `bun run migration:up` | aplica as migrations pendentes |
| `bun run migration:down` | reverte a última (`bun run migration:down -- --all` reverte todas) |
| `bun run migration:pending` | lista as pendentes |
| `bun run migration:create -- <nome>` | cria uma migration (nome só com `[A-Za-z0-9_]`) |

As migrations são SQL escrito à mão e todas têm `down`.

## Variáveis de ambiente principais

O `.env.example` traz todas, com os defaults. A lista completa, com o motivo de cada número, está em `ARCHITECTURE.md` → "Configuração".

| Variável | Default | Para quê |
|---|---|---|
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | banco da aplicação (obrigatória) |
| `HTTP_PORT` | `3000` | porta da API |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | LocalStack; fora do ambiente local, remova e use credenciais reais via IAM |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `us-east-1`, `test`, `test` | credenciais do LocalStack |
| `SQS_WAGER_QUEUE_NAME`, `SQS_WAGER_DLQ_NAME`, `SQS_WAGER_EVENTS_QUEUE_NAME` | `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo` | filas; lidas também pelo compose, que as cria |
| `SQS_CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga cada loop de fundo |
| `SQS_CONSUMER_MAX_ATTEMPTS` | `5` | tentativas antes da DLQ |
| `PENDING_REFERENCE_TTL_MS` | `3600000` (1h) | prazo para a referência de um REFUND/ROLLBACK aparecer |
| `SHUTDOWN_BUDGET_MS` | `25000` | teto da soma dos prazos de shutdown |

A configuração é validada no boot: uma variável inválida derruba o processo com a lista de problemas.

## Estrutura

```
src/
  domain/          entidades, Money, máquina de estados, eventos, failureCode (sem NestJS, sem ORM)
  application/     use cases (processar transação, abrir wallet, resolver pendentes) e portas
  infrastructure/  config, MikroORM (registros, migrations, unit of work), SQS, outbox, logs e métricas
  interfaces/      controllers HTTP, consumidor SQS, outbox publisher e worker de pendentes
test/
  unit/  integration/  concurrency/  multi/  chaos/
docker/            init do Postgres (banco de testes) e do LocalStack (filas)
docker-compose.yml Postgres + LocalStack; profile `multi` com 3 réplicas
Dockerfile         imagem da aplicação (oven/bun:1.4)
```
