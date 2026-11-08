/**
 * Sonda de recursos (diagnóstico do teste de carga, docs/CARGA.md). Roda em paralelo ao
 * `bun run test:load` e grava uma linha JSON por segundo: latência de `select 1` no Postgres,
 * latência de `GetQueueAttributes` no LocalStack, CPU do host e `docker stats` dos containers.
 *
 *   bun test/load/diagnostics/probe.ts <saida.jsonl> <segundos>
 *
 * Endpoints locais do docker compose (os mesmos do .env.test).
 */
import { SQL } from 'bun';
import { cpus } from 'node:os';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

const [out, secondsArg] = process.argv.slice(2);
if (!out) throw new Error('uso: bun test/load/diagnostics/probe.ts <saida.jsonl> <segundos>');
const seconds = Number(secondsArg ?? 150);

const sql = new SQL('postgres://wagering:wagering@localhost:5432/wagering_test', { max: 1 });
const sqs = new SQSClient({ region: 'us-east-1', endpoint: 'http://localhost:4566', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: `probe-${Date.now()}` }));

const cpuSnapshot = () =>
  cpus().reduce(
    (acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      return { busy: acc.busy + total - cpu.times.idle, total: acc.total + total };
    },
    { busy: 0, total: 0 },
  );

const started = Date.now();
const lines: string[] = [];
let previous = cpuSnapshot();
let docker: string[] = [];

// `docker stats --no-stream` leva ~1–2s: roda num laço próprio e a sonda usa o último valor.
const dockerLoop = (async () => {
  while (Date.now() - started < seconds * 1_000) {
    const proc = Bun.spawn(['docker', 'stats', '--no-stream', '--format', '{{.Name}}={{.CPUPerc}}'], { stdout: 'pipe' });
    docker = (await new Response(proc.stdout).text()).trim().split('\n');
  }
})();

while (Date.now() - started < seconds * 1_000) {
  const tick = Date.now();
  const pgStart = performance.now();
  await sql`select 1`;
  const pgMs = performance.now() - pgStart;
  const lsStart = performance.now();
  await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }));
  const localstackMs = performance.now() - lsStart;
  const now = cpuSnapshot();
  const hostCpu = (100 * (now.busy - previous.busy)) / (now.total - previous.total);
  previous = now;
  lines.push(JSON.stringify({ t: tick, pgMs: +pgMs.toFixed(1), localstackMs: +localstackMs.toFixed(1), hostCpu: Math.round(hostCpu), docker }));
  await Bun.sleep(Math.max(0, 1_000 - (Date.now() - tick)));
}

await dockerLoop;
await Bun.write(out, lines.join('\n'));
await sqs.send(new DeleteQueueCommand({ QueueUrl }));
process.exit(0);
