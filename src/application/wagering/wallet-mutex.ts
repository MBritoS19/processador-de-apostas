/** Devolve o mutex. Chamar de novo não faz nada. */
export type Release = () => void;

interface Waiter {
  grant(): void;
}

/**
 * Mutex assíncrono por walletId, em memória, UM por processo (instância única via DI). É só
 * otimização: numa wallet disputada, no máximo 1 requisição por instância fica esperando o
 * `FOR UPDATE` segurando uma conexão do pool; as outras esperam aqui, sem conexão. A correção
 * continua garantida pelo `FOR UPDATE` (as outras instâncias não veem este mutex).
 * ARCHITECTURE.md → "Concorrência".
 *
 * Ordem de chegada (FIFO). Uma entrada no Map existe só enquanto a wallet tem dono; o último
 * `release` sem ninguém esperando a remove (sem crescimento de memória).
 */
export class WalletMutex {
  /** walletId → fila de espera. Presente no Map = mutex com dono. */
  private readonly held = new Map<string, Waiter[]>();

  /** Espera até `timeoutMs`; `undefined` se não conseguiu (quem desistiu sai da fila e nunca recebe o mutex). */
  acquire(walletId: string, timeoutMs: number): Promise<Release | undefined> {
    const waiters = this.held.get(walletId);
    if (waiters === undefined) {
      this.held.set(walletId, []);
      return Promise.resolve(this.releaser(walletId));
    }
    if (timeoutMs <= 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        resolve(undefined);
      }, timeoutMs);
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(timer);
          resolve(this.releaser(walletId));
        },
      };
      waiters.push(waiter);
    });
  }

  /** Wallets com dono neste processo (para testes e diagnóstico). */
  get size(): number {
    return this.held.size;
  }

  private releaser(walletId: string): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiters = this.held.get(walletId);
      const next = waiters?.shift();
      // O mutex passa direto para o próximo da fila: ninguém que chega depois fura a fila.
      if (next === undefined) this.held.delete(walletId);
      else next.grant();
    };
  }
}
