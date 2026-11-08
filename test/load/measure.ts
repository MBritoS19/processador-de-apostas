import { cpus, freemem, platform, release, totalmem, version as osVersion } from 'node:os';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { buildMikroOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { WAGER_LOCK_TIMEOUT_MS } from '../../src/infrastructure/persistence/mikro-orm-wager-unit-of-work';
import { ROOT, type Instance } from '../multi/harness';
import type { Rows } from '../multi/consistency';

/** Utilitários de medição do `test:load`: percentis, /metrics, ambiente e tabela. */

/** Percentil por posto mais próximo (nearest-rank) sobre uma cópia ordenada. */
export function percentiles(values: readonly number[]): { n: number; p50: number; p95: number; p99: number; max: number } {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = Float64Array.from(values).sort();
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
  return { n: sorted.length, p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1]! };
}

/** Inteiro positivo de uma env var, ou o padrão. Valor inválido derruba a suíte. */
export function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new Error(`${name} deve ser um inteiro positivo (recebido: "${raw}")`);
  return Number(raw);
}

export function levelsFromEnv(name: string, fallback: number[]): number[] {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const levels = raw.split(',').map((part) => part.trim());
  if (levels.some((level) => !/^\d+$/.test(level) || Number(level) < 2)) {
    throw new Error(`${name} deve ser uma lista de inteiros >= 2 separados por vírgula (recebido: "${raw}")`);
  }
  return levels.map(Number);
}

/** Séries do formato Prometheus (`nome{labels} valor`), somadas entre as instâncias. */
export type MetricSnapshot = Map<string, number>;

export async function scrape(instances: readonly Instance[]): Promise<MetricSnapshot> {
  const total: MetricSnapshot = new Map();
  for (const instance of instances) {
    const text = await (await fetch(`${instance.url}/metrics`, { signal: AbortSignal.timeout(5_000) })).text();
    for (const line of text.split('\n')) {
      if (!line.startsWith('wagering_') ) continue;
      const space = line.lastIndexOf(' ');
      const series = line.slice(0, space);
      const value = Number(line.slice(space + 1));
      if (Number.isFinite(value)) total.set(series, (total.get(series) ?? 0) + value);
    }
  }
  return total;
}

/** Delta de contadores entre dois snapshots, agrupado: `{ métrica: { labels: delta } }` (só deltas ≠ 0). */
export function counterDelta(before: MetricSnapshot, after: MetricSnapshot, names: readonly string[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const name of names) out[name] = {};
  for (const [series, value] of after) {
    const brace = series.indexOf('{');
    const name = brace < 0 ? series : series.slice(0, brace);
    if (!names.includes(name)) continue;
    const delta = value - (before.get(series) ?? 0);
    if (delta !== 0) out[name]![brace < 0 ? '' : series.slice(brace)] = delta;
  }
  return out;
}

export const sumOf = (group: Record<string, number> | undefined): number =>
  Object.values(group ?? {}).reduce((total, value) => total + value, 0);

async function run(command: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return out.trim();
  } catch (error) {
    return `indisponível (${error instanceof Error ? error.message : String(error)})`;
  }
}

/** Ambiente da execução: máquina, versões, pool e configs relevantes. */
export async function collectEnvironment(rows: Rows, instanceEnv: Record<string, string>): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const pool = buildMikroOrmConfig(config).pool;
  const [pg] = await rows<Record<string, string>>(
    `select version() as version, current_setting('max_connections') as max_connections,
            current_setting('shared_buffers') as shared_buffers, current_setting('synchronous_commit') as synchronous_commit`,
  );
  let localstack: unknown = 'indisponível';
  try {
    const health = (await (await fetch(`${config.aws.endpointUrl ?? 'http://localhost:4566'}/_localstack/health`)).json()) as { version?: string };
    localstack = health.version;
  } catch {
    // fica "indisponível"
  }
  const cpuList = cpus();
  return {
    capturedAt: new Date().toISOString(),
    gitCommit: await run(['git', 'rev-parse', '--short', 'HEAD']),
    host: {
      os: `${platform()} ${release()} (${osVersion()})`,
      cpuModel: cpuList[0]?.model.trim(),
      logicalCores: cpuList.length,
      ramGiB: +(totalmem() / 2 ** 30).toFixed(1),
      freeRamGiBAtStart: +(freemem() / 2 ** 30).toFixed(1),
    },
    bun: Bun.version,
    docker: {
      server: await run(['docker', 'version', '--format', '{{.Server.Version}}']),
      vm: await run(['docker', 'info', '--format', '{{.OperatingSystem}} | {{.NCPU}} CPUs | {{.MemTotal}} bytes']),
    },
    postgres: pg,
    localstack,
    app: {
      instances: 3,
      poolPerInstance: pool,
      // Por tentativa do use case (2 tentativas); o worker de pendentes usa 2s.
      lockTimeoutMs: WAGER_LOCK_TIMEOUT_MS,
      lockAttempts: 2,
      instanceEnv,
      logLevel: process.env['LOG_LEVEL'] ?? 'info',
    },
    caveat: 'gerador de carga, 3 instâncias, Postgres e LocalStack na MESMA máquina (competem por CPU)',
  };
}

const pad = (value: unknown, width: number) => String(value).padStart(width);

/** Tabela-resumo no terminal: uma linha por cenário × nível, em dois blocos (síncrono e assíncrono). */
export function printSummary(runs: ReadonlyArray<Record<string, any>>): void {
  const ms = (value: number) => value.toFixed(1);
  const lines: string[] = [];
  lines.push('');
  lines.push('HTTP (janela de medição; latência por tentativa, em ms)');
  const h1 = ['cenário', 'cli', 'req/s', 'tx/s', 'proc/s', 'p50', 'p95', 'p99', 'máx', '2xx', '422', 'erro', 'erro%', 'lock', 'ok?'];
  const w1 = [16, 4, 8, 8, 8, 7, 7, 7, 8, 7, 6, 6, 6, 6, 4];
  lines.push(h1.map((h, i) => (i === 0 ? h.padEnd(w1[i]!) : pad(h, w1[i]!))).join(' '));
  for (const r of runs) {
    const http = r['http'];
    lines.push(
      [
        String(r['scenario']).padEnd(w1[0]!),
        pad(r['clients'], w1[1]!),
        pad(http.requestsPerSecond.toFixed(1), w1[2]!),
        pad(r['throughput'].transactionsPerSecond.toFixed(1), w1[3]!),
        pad(r['throughput'].processedPerSecond.toFixed(1), w1[4]!),
        pad(ms(http.latencyMs.p50), w1[5]!),
        pad(ms(http.latencyMs.p95), w1[6]!),
        pad(ms(http.latencyMs.p99), w1[7]!),
        pad(ms(http.latencyMs.max), w1[8]!),
        pad(http.ok2xx, w1[9]!),
        pad(http.business422, w1[10]!),
        pad(http.errors, w1[11]!),
        pad((http.errorRate * 100).toFixed(2), w1[12]!),
        pad(sumOf(r['metrics'].window['wagering_lock_conflicts_total']), w1[13]!),
        pad(r['consistency'].ok ? 'sim' : 'NÃO', w1[14]!),
      ].join(' '),
    );
  }
  lines.push('');
  lines.push('Assíncrono (fila, outbox, retries; ms salvo indicação)');
  const h2 = ['cenário', 'cli', 'sqs env', 'e2e p50', 'e2e p95', 'e2e p99', 'e2e máx', 'lag máx', 'lag p95', 'fila máx', 'retry', 'DLQ', 'replay', 'quiesc s'];
  const w2 = [16, 4, 8, 8, 8, 8, 8, 8, 8, 8, 6, 4, 7, 8];
  lines.push(h2.map((h, i) => (i === 0 ? h.padEnd(w2[i]!) : pad(h, w2[i]!))).join(' '));
  for (const r of runs) {
    const e2e = r['queue'].endToEndMs;
    const window = r['metrics'].window;
    lines.push(
      [
        String(r['scenario']).padEnd(w2[0]!),
        pad(r['clients'], w2[1]!),
        pad(r['queue'].sentInWindow, w2[2]!),
        pad(e2e.n ? ms(e2e.p50) : '-', w2[3]!),
        pad(e2e.n ? ms(e2e.p95) : '-', w2[4]!),
        pad(e2e.n ? ms(e2e.p99) : '-', w2[5]!),
        pad(e2e.n ? ms(e2e.max) : '-', w2[6]!),
        pad(r['outbox'].lagMs.max.toFixed(0), w2[7]!),
        pad(r['outbox'].lagMs.p95.toFixed(0), w2[8]!),
        pad(r['queue'].depth.max, w2[9]!),
        pad(sumOf(window['wagering_retries_total']), w2[10]!),
        pad(sumOf(window['wagering_dlq_messages_total']), w2[11]!),
        pad(sumOf(window['wagering_idempotent_replays_total']), w2[12]!),
        pad((r['quiescenceMs'] / 1000).toFixed(1), w2[13]!),
      ].join(' '),
    );
  }
  console.log(lines.join('\n'));
}
