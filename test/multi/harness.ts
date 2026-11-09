import type { Subprocess } from 'bun';
import { join } from 'node:path';

/**
 * Harness do teste multi-instância. Cada instância é um processo `bun src/main.ts`
 * de verdade: PID próprio, pool de conexões próprio, nada compartilhado em memória.
 */

export const ROOT = join(import.meta.dir, '..', '..');

/** PRNG determinístico (mulberry32): a mesma seed gera sempre a mesma carga. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed da carga: `MULTI_SEED` (inteiro não negativo) ou o padrão. Valor inválido derruba o teste. */
export function seedFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`MULTI_SEED deve ser um inteiro não negativo (recebido: "${raw}")`);
  return Number(raw.trim());
}

/** Dinheiro em centavos como bigint (nunca number), formatado com 2 casas. */
export function cents(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** Repete `check` até passar ou estourar o prazo; o erro diz o que se esperava e o último motivo. */
export async function eventually(
  description: string,
  check: () => Promise<void> | void,
  timeoutMs = 60_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      last = error;
      if (Date.now() > deadline) {
        const reason = last instanceof Error ? last.message : String(last);
        throw new Error(`eventually estourou ${timeoutMs}ms: ${description}\n  último motivo: ${reason}`);
      }
      await Bun.sleep(intervalMs);
    }
  }
}

export async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error('sem porta livre');
  return port;
}

export interface InstanceEnv {
  [name: string]: string;
}

/** Todos os processos já iniciados: mortos na saída do `bun test`, mesmo se interrompido. */
const spawned = new Set<Subprocess>();
process.on('exit', () => {
  for (const proc of spawned) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
});

/** Um processo da aplicação, com a saída lida o tempo todo (para o pipe nunca encher). */
export class Instance {
  private proc: Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  /** Cauda de log de TODAS as vidas do processo (diagnóstico de falha). */
  private readonly tail: string[] = [];
  /** Eventos do pino por tipo (e `evento:outcome`), contados só na vida atual do processo. */
  private readonly counts = new Map<string, number>();
  /** Incrementa a cada `start()`: linhas tardias de uma vida anterior não entram nos contadores. */
  private generation = 0;
  pid = 0;

  constructor(
    readonly label: string,
    readonly port: number,
    private readonly env: InstanceEnv,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get running(): boolean {
    return this.proc !== undefined && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  /** Eventos `event`, `event:outcome` ou `event@http|sqs` registrados desde o último `start()`. */
  count(event: string): number {
    return this.counts.get(event) ?? 0;
  }

  start(): void {
    if (this.running) throw new Error(`${this.label} já está rodando`);
    this.generation++;
    this.counts.clear();
    this.proc = Bun.spawn([process.execPath, 'src/main.ts'], {
      cwd: ROOT,
      env: { ...process.env, ...this.env, HTTP_PORT: String(this.port) },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    spawned.add(this.proc);
    this.pid = this.proc.pid;
    this.tail.push(`--- start #${this.generation} (pid ${this.pid}) ---`);
    void this.pump(this.proc.stdout, this.generation);
    void this.pump(this.proc.stderr, this.generation);
  }

  private async pump(stream: ReadableStream<Uint8Array>, generation: number): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for await (const chunk of stream) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          this.record(buffered.slice(0, newline), generation);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf('\n');
        }
      }
    } catch {
      // processo morto: o stream fecha com erro, e isso é esperado nos SIGKILL
    }
    if (buffered) this.record(buffered, generation);
  }

  private record(line: string, generation: number): void {
    if (!line.trim()) return;
    // Todas as linhas vão para a cauda (limitada); só as JSON da vida atual entram nos contadores.
    this.tail.push(line);
    if (this.tail.length > 4000) this.tail.splice(0, this.tail.length - 3000);
    if (generation !== this.generation) return;
    try {
      const parsed = JSON.parse(line) as { event?: string; outcome?: string; messageId?: string };
      if (parsed.event) {
        // `evento`, `evento:outcome` e `evento@canal` (com messageId = veio do SQS; sem = HTTP).
        const keys = [parsed.event, `${parsed.event}@${parsed.messageId === undefined ? 'http' : 'sqs'}`];
        if (parsed.outcome) keys.push(`${parsed.event}:${parsed.outcome}`);
        for (const key of keys) this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      }
    } catch {
      // linha que não é JSON (ex.: erro de boot em texto): fica só na cauda
    }
  }

  async waitReady(timeoutMs = 45_000): Promise<void> {
    await eventually(
      `${this.label} (porta ${this.port}) responde 200 em /health/ready`,
      async () => {
        if (!this.running) throw new Error(`o processo morreu\n${this.logTail(15)}`);
        const response = await fetch(`${this.url}/health/ready`, { signal: AbortSignal.timeout(2_000) });
        if (response.status !== 200) throw new Error(`status ${response.status}`);
      },
      timeoutMs,
      200,
    );
  }

  /** Espera o processo terminar por conta própria (ex.: SIGKILL injetado), sem timer solto. */
  async waitExit(timeoutMs: number): Promise<void> {
    await eventually(
      `${this.label} terminou`,
      () => {
        if (this.running) throw new Error('ainda rodando');
      },
      timeoutMs,
      20,
    );
    await this.proc?.exited;
  }

  /** SIGKILL: sem handlers, sem shutdown gracioso, como uma queda real. */
  async kill(): Promise<void> {
    if (!this.proc) return;
    if (this.running) this.proc.kill('SIGKILL');
    await this.proc.exited;
  }

  logTail(lines = 25): string {
    return this.tail
      .slice(-lines)
      .map((line) => `    [${this.label}] ${line.slice(0, 300)}`)
      .join('\n');
  }
}

export interface HttpResult {
  status: number;
  body: Record<string, any>;
  attempts: number;
}

/**
 * Cliente de provedor: reenvia a MESMA requisição (mesma Idempotency-Key) em erro de rede e
 * em 503, como o contrato manda (ARCHITECTURE.md → "API HTTP"). Em qualquer outra resposta, para.
 */
export async function callWithRetry(
  instances: readonly Instance[],
  pick: number,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; maxAttempts?: number } = {},
): Promise<HttpResult> {
  const maxAttempts = options.maxAttempts ?? 100;
  let lastError = 'nenhuma tentativa';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Se a instância escolhida caiu, tenta a seguinte: o provedor está atrás de um balanceador.
    const instance = instances[(pick + attempt - 1) % instances.length]!;
    try {
      const response = await fetch(`${instance.url}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...options.headers },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      if (response.status !== 503) {
        return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {}, attempts: attempt };
      }
      lastError = '503';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(50 + attempt * 10);
  }
  throw new Error(`${method} ${path} sem resposta definitiva em ${maxAttempts} tentativas (último: ${lastError})`);
}
