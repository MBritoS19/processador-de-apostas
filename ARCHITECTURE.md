# Arquitetura

Decisões técnicas do processador de apostas, com motivo e trade-off.
Cada seção indica a fase em que foi tomada; seções futuras serão adicionadas conforme o `PROGRESSO.md`.

---

## 1. Runtime e estrutura (Fase 0)

- **Bun 1.4** como runtime, gerenciador de pacotes e test runner. O Bun executa TypeScript direto, sem build; `bun run typecheck` (`tsc --noEmit`) é quem garante os tipos, já que o Bun não checa tipos.
  - *Trade-off:* um passo a mais para lembrar (typecheck separado do teste), em troca de ciclo de execução sem build.
- **TypeScript estrito**, incluindo `noUncheckedIndexedAccess` e `exactOptionalPropertyTypes`: acesso a índice devolve `T | undefined` e opcional não aceita `undefined` implícito — relevante para não deixar valores monetários ou ids "sumirem" silenciosamente.
- **Camadas** (`domain` → `application` → `infrastructure` / `interfaces`): o domínio não importa NestJS nem ORM. Portas (interfaces) ficam em `application/ports`; adaptadores em `infrastructure`. Lógica de aplicação sem framework (ex.: `ReadinessService`) fica em `application` e é instanciada pelos módulos Nest via factory.
- **Configuração** validada no boot (`loadConfig`): variável ausente ou inválida derruba o processo antes de aceitar tráfego, reportando todos os problemas de uma vez (inclusive credenciais AWS pela metade, que fariam o SDK cair silenciosamente na cadeia padrão).
- **Módulos Nest** por responsabilidade, e o `AppModule` só compõe:

  | Módulo | Fornece / exporta |
  |---|---|
  | `ConfigModule` (global) | `APP_CONFIG`, a config já validada |
  | `PersistenceModule` | MikroORM + `PostgresReadinessCheck` |
  | `MessagingModule` | `SQSClient` (e o fecha no shutdown) + `SqsReadinessCheck` |
  | `HealthModule` | controller de health + `ReadinessService` |

  O `AppModule.register(config)` recebe a config pronta, o que permite aos testes subir a aplicação contra outro banco/endpoint sem mexer em `process.env`. Consumidor SQS, outbox publisher e workers das próximas fases importam `MessagingModule`/`PersistenceModule` em vez de crescer o módulo raiz.

## 2. ORM: MikroORM 6 (Fase 0)

**Escolha:** MikroORM, opção preferencial do desafio.

**Motivo:** Unit of Work e Identity Map explícitos, `em.transactional()` e `LockMode` (pessimista/otimista) nativos — exatamente as ferramentas que a estratégia de concorrência por wallet vai precisar.

**Mapeamento sem decorators no domínio:** as entidades serão mapeadas com `EntitySchema` dentro de `infrastructure/persistence`. As classes de domínio continuam com construtor `private` e factories, sem nenhum import de ORM (CHALLENGE §6.1).
- *Trade-off:* `EntitySchema` é mais verboso que decorators e o mapeamento fica longe da classe. Aceito em troca de um domínio testável sem ORM.

**Contexto do EntityManager — uma regra só para todas as entradas:**
- `allowGlobalContext: false` proíbe usar o `EntityManager` global (identity map compartilhado entre requisições).
- `registerRequestContext: false` desliga o contexto implícito por request HTTP do `@mikro-orm/nestjs`.
- Resultado: HTTP, consumidor SQS e workers seguem a mesma regra — todo use case abre o próprio contexto (`em.fork()` / `em.transactional()`).
- *Trade-off:* um pouco mais de cerimônia em cada use case, em troca de não haver comportamento diferente entre a entrada HTTP (que teria contexto "de graça") e os workers (que lançariam erro).

**Conexão preguiçosa (`connect: false`, só na aplicação):** a instância sobe mesmo com o Postgres fora; o `/health/ready` reporta `not_ready` e o tráfego não chega até o banco voltar.
- *Motivo:* com conexão eager, uma queda do banco derruba o boot de todas as instâncias, que entram em crash loop (CHALLENGE §3: "PostgreSQL e SQS podem ficar temporariamente indisponíveis").
- *Trade-off:* uma `DATABASE_URL` errada não falha no boot — aparece no readiness. O CLI de migrations continua com conexão eager (falha rápido).

**Pool:** `max: 10` por instância e `acquireTimeoutMillis: 10s`.
- Com N instâncias o total é N × 10; o `max_connections` do Postgres (100 por padrão) comporta folgadamente 3+ instâncias mais workers.
- O acquire timeout curto faz requisições falharem como erro transitório quando o banco está fora, em vez de empilharem por 60s (default do tarn).
- *Trade-off:* sob contenção extrema de pool, uma requisição pode falhar em vez de esperar mais — preferível a acumular latência sem limite.

## 3. Migrations (Fase 0)

- Executadas por um CLI próprio (`src/infrastructure/persistence/migrate.ts`) que usa `orm.getMigrator()` programaticamente. **Motivo:** não depender do CLI do MikroORM rodando sob Bun (resolução de config TS, ts-node etc.).
  - Argumentos são validados **antes** de conectar ao banco: comando/opção desconhecida ou nome inválido saem com código 1 e a mensagem de uso.
  - O nome da migration vira parte do nome da classe TS, então só aceita `[A-Za-z0-9_]` — um `add-wallets` geraria um arquivo que quebra todas as migrations.
  - *Trade-off:* mais um pedaço de código para manter, em vez do CLI pronto do ORM.
- **Escritas à mão em SQL** (`snapshot: false`, sem geração por diff). O schema — constraints, índices, triggers — é parte do que é avaliado, e precisa ser explícito e revisável, não derivado das entidades.
  - *Trade-off:* nada detecta automaticamente divergência entre o `EntitySchema` e o SQL; isso fica a cargo dos testes de integração contra o banco real.
- `transactional: true` + `allOrNothing: true`: um lote de migrations aplica inteiro ou nada.
- Toda migration tem `down`. O ciclo up → down → up é testado em `test/integration/infrastructure/migrations.test.ts`, e o CLI em `migrate-cli.test.ts`.
- A migration `baseline` é intencionalmente vazia: só prova o ciclo. As tabelas nascem na Fase 2, e aí o teste passa a verificar que o `down` remove de fato o schema.

## 4. Infraestrutura local (Fase 0)

| Serviço | Imagem | Observação |
|---|---|---|
| PostgreSQL | `postgres:16.10-alpine` | init cria o banco `wagering_test`, isolado do banco de dev |
| LocalStack | `localstack/localstack:4.9.2` | só SQS; versão fixada |

- **Portas publicadas só em `127.0.0.1`:** as credenciais locais são fixas e conhecidas; não expor Postgres e a fila de entrada de transações para a rede.
- **LocalStack com versão fixa:** versões recentes da imagem passaram a exigir auth token. A 4.9.2 roda sem conta.
  - *Trade-off:* sem correções e novidades de versões futuras. Alternativa registrada caso deixe de funcionar: **MiniStack**, aceito pelo desafio.
- **Healthcheck do LocalStack** só fica verde quando o init terminou **e** todos os scripts terminaram com `SUCCESSFUL`. Só `"completed": true` não basta: um script com erro também completa. Assim `docker compose up --wait` garante que as filas existem.
- **`.gitattributes` força LF:** no Windows o Git converteria o script de init para CRLF e o bash do container quebraria.
- **Testes** usam `.env.test` (carregado automaticamente pelo `bun test`, que define `NODE_ENV=test`). O arquivo é completo por conta própria — não depende do `.env` do desenvolvedor — e é versionado com **somente** valores locais.

## 5. Filas SQS (Fase 0)

| Fila | Atributos |
|---|---|
| `wager-transactions-dlq.fifo` | FIFO, `ContentBasedDeduplication=false`, retenção de 14 dias |
| `wager-transactions.fifo` | FIFO, `ContentBasedDeduplication=false`, `VisibilityTimeout=30s`, `RedrivePolicy` → DLQ com `maxReceiveCount=5` |

- **Nomes:** `SQS_WAGER_QUEUE_NAME` / `SQS_WAGER_DLQ_NAME`, lidos pela aplicação **e** repassados pelo compose ao script de init, com os mesmos defaults (os nomes do CHALLENGE §10). Uma única fonte evita a aplicação procurar uma fila que o init nunca criou.
- **Sem dedup por conteúdo:** o produtor informa `MessageDeduplicationId` explícito. De qualquer forma, a dedup do broker é **otimização**; a garantia é a inbox persistente no Postgres (CHALLENGE §8).
  - *Trade-off:* todo produtor precisa gerar o dedup id; em troca, dois payloads idênticos legítimos não são descartados pelo broker por coincidência de conteúdo.
- **`maxReceiveCount=5`:** valor inicial, configurável por `SQS_MAX_RECEIVE_COUNT` (lido pelo compose; mudar exige recriar o container do LocalStack). Será revisto na Fase 5, junto com a classificação de erros (negócio / transitório / permanente).
  - *Trade-off:* baixo demais manda para a DLQ mensagens que sobreviveriam a uma indisponibilidade curta; alto demais atrasa a ida à DLQ de mensagens permanentemente inválidas.
- **`VisibilityTimeout=30s`:** folga ampla para uma transação curta no banco. A Fase 5 decide se o consumidor estende a visibilidade em processamento longo.
- Criação via script de init (`docker/localstack/init/ready.d/01-create-queues.sh`) que valida nomes e `maxReceiveCount` antes de usá-los. É idempotente para os mesmos atributos; com atributos diferentes numa fila existente, a criação falha (o compose atual não persiste o estado do LocalStack, então isso não ocorre hoje).

## 6. Health checks (Fase 0)

Abertos, sem autenticação (CHALLENGE §2).

**`GET /health/live`** — sempre `200 {"status":"alive"}` enquanto o processo responde. **Não** consulta dependências: uma queda do Postgres não deve fazer o orquestrador reiniciar todas as instâncias (o que só pioraria a recuperação).

**`GET /health/ready`** — executa em paralelo os `ReadinessCheck` registrados, cada um com timeout próprio (`HEALTH_CHECK_TIMEOUT_MS`, 2s):

| Check (chave pública) | O que faz |
|---|---|
| `postgres` | `select 1` com timeout e cancelamento no servidor (a conexão volta ao pool) |
| `sqs` | `GetQueueUrl` da fila principal e da DLQ, com `abortSignal` |

Contrato da resposta:

```json
// 200
{ "status": "ready", "dependencies": { "postgres": { "status": "up" }, "sqs": { "status": "up" } } }

// 503
{ "status": "not_ready", "dependencies": { "postgres": { "status": "down", "reason": "unreachable" }, "sqs": { "status": "up" } } }
```

- `reason` é um **conjunto fechado**: `timeout` (não respondeu no prazo), `unreachable` (falha de rede/conexão), `error` (qualquer outro erro, ex.: fila inexistente).
- A resposta **nunca** carrega mensagem de driver, host, porta ou stack. O detalhe (nome e código do erro, sem payload) vai para o log do servidor.
- As chaves `postgres` e `sqs` vêm de `ReadinessCheck.name` e são contrato público: renomear um check é mudança de contrato.
- **Por que uma porta própria** (`ReadinessCheck` + `ReadinessService`) em vez de `@nestjs/terminus`: dois checks não justificam a dependência, e a lógica (timeout, classificação) fica testável sem framework. Novos checks (ex.: outbox lag) entram como mais um adaptador.
  - *Trade-off:* mantemos ~80 linhas que o terminus daria prontas.
- **503** é o código para "falha transitória de infraestrutura" e deve ser o mesmo nos demais endpoints (CHALLENGE §9).
