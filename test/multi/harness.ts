import type { Subprocess } from 'bun';
import { join } from 'node:path';

/**
 * Harness do teste multi-instância (Fase 9). Cada instância é um processo `bun src/main.ts`
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

/** Um processo da aplicação, com a saída lida o tempo todo (para o pipe nunca encher). */
export class Instance {
  private proc: Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  private readonly tail: string[] = [];
  /** Linhas JSON do pino já parseadas por tipo de evento (contadores para o relatório). */
  readonly counts = new Map<string, number>();
  private readonly seenEvents = new Set<string>();
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

  /** Terminou por conta própria ou por SIGKILL. */
  get exited(): Promise<number> {
    if (!this.proc) throw new Error(`${this.label} nunca foi iniciada`);
    return this.proc.exited;
  }

  has(event: string): boolean {
    return this.seenEvents.has(event);
  }

  count(event: string): number {
    return this.counts.get(event) ?? 0;
  }

  /** Linhas de log que contêm o texto (para provar, por exemplo, um DUPLICATE_MESSAGE). */
  linesMatching(text: string): string[] {
    return this.tail.filter((line) => line.includes(text));
  }

  start(): void {
    if (this.running) throw new Error(`${this.label} já está rodando`);
    this.seenEvents.clear();
    this.proc = Bun.spawn([process.execPath, 'src/main.ts'], {
      cwd: ROOT,
      env: { ...process.env, ...this.env, HTTP_PORT: String(this.port) },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.pid = this.proc.pid;
    void this.pump(this.proc.stdout);
    void this.pump(this.proc.stderr);
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for await (const chunk of stream) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          this.record(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf('\n');
        }
      }
    } catch {
      // processo morto: o stream fecha com erro, e isso é esperado nos SIGKILL
    }
    if (buffered) this.record(buffered);
  }

  private record(line: string): void {
    if (!line.trim()) return;
    this.tail.push(line);
    // Só linhas de decisão (ack/retry/DLQ/fault) ficam para consulta; o resto, só a cauda.
    if (this.tail.length > 4000) this.tail.splice(0, this.tail.length - 3000);
    try {
      const parsed = JSON.parse(line) as { event?: string; outcome?: string };
      if (parsed.event) {
        this.seenEvents.add(parsed.event);
        this.counts.set(parsed.event, (this.counts.get(parsed.event) ?? 0) + 1);
        if (parsed.outcome) {
          const key = `${parsed.event}:${parsed.outcome}`;
          this.seenEvents.add(key);
          this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
        }
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
 * em 503, como o contrato manda (ARCHITECTURE §16). Em qualquer outra resposta, para.
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
