# Processador de Apostas

[![CI](https://github.com/MBritoS19/processador-de-apostas/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MBritoS19/processador-de-apostas/actions/workflows/ci.yml)

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de provedores por HTTP e por SQS. Saldo, ledger, diário de partidas dobradas, inbox e outbox são gravados na mesma transação SQL, os eventos saem depois do commit por um outbox publisher, e o serviço funciona com várias instâncias em paralelo.

```mermaid
flowchart LR
    P[Provedor] -->|POST /wagering/transactions<br/>Idempotency-Key| H[API HTTP]
    P -->|mensagem| Q[(wager-transactions.fifo)]
    Q --> C[Consumidor SQS]
    H --> U[ProcessWagerTransaction]
    C --> U
    subgraph TX [Uma transação SQL]
        direction TB
        L[FOR UPDATE na wallet] --> R[regras + idempotência]
        R --> W[transação + saldo + ledger<br/>+ diário + inbox + outbox]
    end
    U --> TX
    TX -->|COMMIT| DB[(PostgreSQL)]
    DB -->|SKIP LOCKED, depois do commit| O[Outbox publisher]
    O --> E[(wager-events.fifo)]
    C -.->|ack só depois do commit| Q
    C -.->|falha permanente| D[(DLQ)]
```

Qualquer número de instâncias roda o mesmo processo (API, consumidor, outbox publisher e worker de referências pendentes) sobre o mesmo Postgres. Detalhes em `ARCHITECTURE.md` → "Visão geral em 1 minuto".

- Especificação: [`CHALLENGE.md`](CHALLENGE.md)
- Arquitetura, decisões, trade-offs e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md) (comece pela "Visão geral em 1 minuto")

Stack: Bun 1.x, TypeScript estrito, NestJS, PostgreSQL 16 com MikroORM 6, AWS SQS via LocalStack e Docker Compose.

## Pré-requisitos

- [Bun](https://bun.sh) 1.4 ou mais recente (`bun --version`)
- Docker com Compose v2 (`docker compose version`)
- Git
- Portas livres em `127.0.0.1`: `5432` (Postgres), `4566` (LocalStack) e `3000` (API)

**Windows:** o projeto roda nativamente (Bun para Windows e Docker Desktop); foi desenvolvido e testado assim. Os comandos abaixo funcionam no PowerShell, no Git Bash e no WSL, com duas exceções no PowerShell, indicadas onde aparecem: copiar o `.env` e definir variável de ambiente na linha de comando. O repositório força LF (`.gitattributes`), então o script de init do LocalStack funciona mesmo com `core.autocrlf=true`.

## Setup do zero

```bash
git clone https://github.com/MBritoS19/processador-de-apostas.git
cd processador-de-apostas
bun install
cp .env.example .env                  # PowerShell: Copy-Item .env.example .env
docker compose up -d --wait           # Postgres 16 + LocalStack; espera os healthchecks (as filas são criadas no init)
bun run migration:up                  # aplica as migrations no banco de desenvolvimento
bun run demo                          # cenário obrigatório: saldo 100, duas BETs de 80 em paralelo
```

A demo sobe a aplicação no próprio processo, numa porta livre, e termina com `OK: uma PROCESSED, uma REJECTED, saldo 20.00` (saída 0) ou `FALHOU` (saída 1). Pode rodar quantas vezes quiser: cada execução usa uma wallet nova.

O `--wait` só volta quando o Postgres aceita conexões e o script de criação das filas terminou com sucesso. O banco de testes `wagering_test` é criado pelo init do Postgres, e as suítes aplicam as migrations nele sozinhas.

**O `docker-compose.yml` fixa o nome do projeto** (`name: processador-de-apostas`). Um segundo clone na mesma máquina reaproveita os mesmos containers e o mesmo volume do Postgres. Como o volume já existe, o init (que cria o `wagering_test`) não roda de novo. Para isolar um clone, use outro nome de projeto em **todos** os comandos do compose, por exemplo `docker compose -p outro-nome up -d --wait` e `docker compose -p outro-nome down`. As portas 5432 e 4566 continuam as mesmas, então só um dos stacks pode estar de pé por vez.

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

## Limitações conhecidas

Resumo. A lista completa, com o que fecharia cada uma, está em `ARCHITECTURE.md` → "Limitações" e "Evolução futura".

- **Sem autenticação:** qualquer cliente que alcance a API age em nome de qualquer provider; wallets não têm vínculo com provider. O desenho está pronto, não implementado.
- **Wallet muito disputada:** a espera pelo lock tem orçamento de ~2s; acima disso, a resposta é `503` com `Retry-After`, e o provider reenvia (a requisição é idempotente).
- **Outbox sem DLQ:** um evento que nunca publica trava só o próprio agregado; fica visível por métrica e log (`outbox_event_stuck`), sem descarte.
- **Sem heartbeat de visibilidade no consumidor SQS:** um lote acima de 60s pode ser reentregue em paralelo; a inbox e o lock evitam efeito duplo.
- **Sem retenção da inbox:** `inbox_messages` cresce sem limite.
- **Regras de reversão:** REFUND depois de WIN é aceito (`ARCHITECTURE.md` → "Regras de negócio").
- **O schema não garante tudo do ledger** (encadeamento `balance_before`, "só PROCESSED tem lançamento"); a reconciliação detecta.

## Testes

Todas as suítes, exceto a de unidade, usam Postgres e LocalStack **reais**: rode `docker compose up -d --wait` antes. Elas usam o banco `wagering_test`, configurado em `.env.test`, que o `bun test` carrega sozinho (com `NODE_ENV=test`); não dependem do seu `.env`. Não rode duas suítes ao mesmo tempo: elas compartilham esse banco.

**A aplicação (`bun run start`/`start:dev`) pode ficar de pé durante os testes**, mas é melhor pará-la:
- Ela não interfere nos resultados: usa o banco `wagering` e as filas padrão, enquanto as suítes usam o `wagering_test`, filas com nome único e portas livres escolhidas na hora.
- O `test:multi` e o `test:load` sobem 3 processos e têm prazos, então CPU ocupada pode atrasá-los.
- O `test:chaos` para o Postgres, e a aplicação de pé vai responder 503 durante a queda.

| Comando | Suíte | Tempo típico |
|---|---|---|
| `bun run typecheck` | `tsc --noEmit` (o Bun não checa tipos) | ~2s |
| `bun run test:unit` | domínio, regras e config, sem I/O | ~5s |
| `bun run test:integration` | migrations, constraints, atomicidade, inbox e redelivery, retry e DLQ, outbox, recuperação | ~1 min |
| `bun run test:concurrency` | paralelismo real num processo (80+80, a mesma BET 50x, publishers e workers concorrentes) | ~10s |
| `bun run test:multi` | 3 processos reais da aplicação, SIGKILL depois do commit e antes do ack, SIGKILL de todas no meio da carga | ~45s |
| `bun test` | todas as suítes acima; termina com 13 `skip` (chaos e load, que só rodam pelos próprios scripts); os logs JSON no meio da saída são esperados | ~2,5 min |
| `bun run test:chaos` | **para o Postgres (~40s) e pausa o LocalStack (~12s)** com 2 processos sob carga; fora do `bun test` (só roda com `CHAOS=1`, que o script define) | ~1,5 min |
| `bun run test:load` | teste de carga: 3 instâncias, 3 cenários × níveis `10,50` mais o quente-frias (50 clientes numa wallet + 10 em wallets frias) (`LOAD_LEVELS=10,50,100` opcional, ~15 min), consistência ao fim de cada rodada; resumo no terminal e JSON em `test/load/results/`; fora do `bun test` (só com `LOAD=1`) | ~11 min |

O `test:chaos` mexe nos containers compartilhados do `docker compose` (`stop`/`start` do Postgres, `pause`/`unpause` do LocalStack) e os restaura no fim, mesmo se falhar. Não rode outra suíte junto.

**O `test:chaos` atua no stack principal:** ele chama `docker compose` **sem** `-p`, então age no projeto `processador-de-apostas`. Se você subiu o stack com outro nome (`docker compose -p outro-nome …`, ver "Setup do zero"), defina o mesmo nome em `COMPOSE_PROJECT_NAME` antes de rodar; sem isso, o teste para e pausa os containers do projeto errado:

```bash
COMPOSE_PROJECT_NAME=outro-nome bun run test:chaos     # PowerShell: $env:COMPOSE_PROJECT_NAME="outro-nome"; bun run test:chaos
```

A matriz que liga cada exigência do `CHALLENGE.md` ao teste que a prova, e o teste de mutação, estão em [`docs/RASTREABILIDADE.md`](docs/RASTREABILIDADE.md).

O `test:multi` sobe processos `bun src/main.ts` locais (não containers), em portas livres escolhidas na hora, cada um com API, consumidor, publisher e worker. A carga é gerada por uma seed **fixa** (`20261107`, impressa no início e na falha), então toda execução gera a mesma carga; a intercalação entre processos continua variando. Para trocar a seed:

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
  unit/  integration/  concurrency/  multi/  chaos/  load/
scripts/           demo.ts (bun run demo)
docs/              RASTREABILIDADE.md (exigência → teste), CARGA.md e carga/ (resultados do teste de carga; final/RESUMO.md com a rodada final)
docker/            init do Postgres (banco de testes) e do LocalStack (filas)
.github/workflows/ CI: typecheck, unidade e integração
docker-compose.yml Postgres + LocalStack; profile `multi` com 3 réplicas
Dockerfile         imagem da aplicação (oven/bun:1.4)
```

## Uso de IA

O projeto foi desenvolvido com assistência de IA (Claude Code). As decisões de arquitetura foram revisadas por mim e estão registradas, com motivo e trade-off, no `ARCHITECTURE.md`. A validação é feita por testes contra Postgres e LocalStack reais, e os números citados nos documentos (testes, carga, caos) vêm de execuções reais. A entrega também passou por uma avaliação independente feita a partir de um clone limpo, seguindo só este README.
