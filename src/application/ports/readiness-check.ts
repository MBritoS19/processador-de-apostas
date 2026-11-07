/**
 * Porta para verificar se uma dependência externa está alcançável.
 * Usada pelo /health/ready; cada adaptador de infraestrutura implementa a sua.
 */
export interface ReadinessCheck {
  /** Nome estável da dependência. É chave pública no JSON do /health/ready. */
  readonly name: string;
  /**
   * Resolve se a dependência está pronta. Rejeita caso contrário; o adaptador
   * deve traduzir falhas de conexão para `DependencyUnreachableError`.
   * Deve respeitar o `signal` (ou ter timeout próprio) para não segurar recursos.
   */
  check(signal: AbortSignal): Promise<void>;
}

/** Falha de rede/conexão: a dependência não respondeu. */
export class DependencyUnreachableError extends Error {
  constructor(dependency: string, options?: { cause?: unknown }) {
    super(`${dependency} inalcançável`, options);
    this.name = 'DependencyUnreachableError';
  }
}

/** Token de injeção para a lista de checks registrados. */
export const READINESS_CHECKS = Symbol('READINESS_CHECKS');
