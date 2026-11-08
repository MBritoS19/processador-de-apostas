import { DependencyUnreachableError, type ReadinessCheck } from '../ports/readiness-check';

/**
 * Motivo de falha exposto publicamente. Conjunto fechado e estável: nunca
 * carrega mensagem de driver, host, porta ou stack.
 */
export type ReadinessFailureReason = 'timeout' | 'unreachable' | 'error';

export type DependencyStatus = { status: 'up' } | { status: 'down'; reason: ReadinessFailureReason };

export interface ReadinessReport {
  readonly status: 'ready' | 'not_ready';
  readonly dependencies: Readonly<Record<string, DependencyStatus>>;
}

/** Recebe o erro detalhado de cada falha, para log no servidor. */
export type ReadinessFailureListener = (dependency: string, reason: ReadinessFailureReason, error: unknown) => void;

class ReadinessTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timeout após ${timeoutMs}ms`);
    this.name = 'ReadinessTimeoutError';
  }
}

/**
 * Executa os checks em paralelo, cada um com timeout próprio, e consolida o resultado.
 * Sem dependência de framework: testável com checks falsos.
 */
export class ReadinessService {
  constructor(
    private readonly checks: readonly ReadinessCheck[],
    private readonly timeoutMs: number,
    private readonly onFailure: ReadinessFailureListener,
  ) {}

  async evaluate(): Promise<ReadinessReport> {
    const results = await Promise.all(this.checks.map((check) => this.run(check)));
    const allUp = results.every(([, result]) => result.status === 'up');
    return { status: allUp ? 'ready' : 'not_ready', dependencies: Object.fromEntries(results) };
  }

  private async run(check: ReadinessCheck): Promise<[string, DependencyStatus]> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ReadinessTimeoutError(this.timeoutMs);
        controller.abort(error);
        reject(error);
      }, this.timeoutMs);
    });

    try {
      await Promise.race([check.check(controller.signal), timeout]);
      return [check.name, { status: 'up' }];
    } catch (error: unknown) {
      const reason = classify(error, controller.signal);
      this.onFailure(check.name, reason, error);
      return [check.name, { status: 'down', reason }];
    } finally {
      clearTimeout(timer);
    }
  }
}

function classify(error: unknown, signal: AbortSignal): ReadinessFailureReason {
  if (error instanceof ReadinessTimeoutError || signal.aborted) return 'timeout';
  if (error instanceof DependencyUnreachableError) return 'unreachable';
  return 'error';
}
