import { describe, expect, it } from 'bun:test';
import { WalletMutex } from '../../../src/application/wagering/wallet-mutex';

const A = 'wallet-a';
const B = 'wallet-b';

describe('WalletMutex', () => {
  it('livre → concede na hora; outra wallet não espera', async () => {
    const mutex = new WalletMutex();
    const a = await mutex.acquire(A, 0);
    const b = await mutex.acquire(B, 0);
    expect(a).toBeFunction();
    expect(b).toBeFunction();
    expect(mutex.size).toBe(2);
    a!();
    b!();
    expect(mutex.size).toBe(0);
  });

  it('concede por ordem de chegada (FIFO), um dono por vez', async () => {
    const mutex = new WalletMutex();
    const order: number[] = [];
    let owners = 0;
    let maxOwners = 0;
    const first = await mutex.acquire(A, 1_000);
    const waiters = [1, 2, 3].map(async (n) => {
      const release = await mutex.acquire(A, 1_000);
      maxOwners = Math.max(maxOwners, ++owners);
      order.push(n);
      await Bun.sleep(n === 1 ? 10 : 1);
      owners--;
      release!();
    });
    first!();
    // Quem chega depois que o mutex começou a ser passado não fura a fila.
    const late = mutex.acquire(A, 1_000).then((release) => {
      order.push(4);
      release!();
    });
    await Promise.all([...waiters, late]);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(maxOwners).toBe(1);
    expect(mutex.size).toBe(0);
  });

  it('timeout → undefined; quem desistiu sai da fila e nunca recebe o mutex', async () => {
    const mutex = new WalletMutex();
    const owner = await mutex.acquire(A, 0);
    const startedAt = performance.now();
    expect(await mutex.acquire(A, 30)).toBeUndefined();
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(25);
    const next = mutex.acquire(A, 1_000);
    owner!();
    const release = await next;
    expect(release).toBeFunction();
    release!();
    expect(mutex.size).toBe(0);
  });

  it('timeout 0 com dono → undefined na hora', async () => {
    const mutex = new WalletMutex();
    const owner = await mutex.acquire(A, 0);
    expect(await mutex.acquire(A, 0)).toBeUndefined();
    owner!();
    expect(mutex.size).toBe(0);
  });

  it('release repetido não faz nada (não entrega o mutex a dois)', async () => {
    const mutex = new WalletMutex();
    const owner = await mutex.acquire(A, 0);
    let granted = 0;
    const waiters = [mutex.acquire(A, 1_000), mutex.acquire(A, 1_000)].map((p) =>
      p.then((release) => {
        granted++;
        return release;
      }),
    );
    owner!();
    owner!();
    const firstRelease = await waiters[0]!;
    await Bun.sleep(5);
    expect(granted).toBe(1);
    firstRelease!();
    (await waiters[1]!)!();
    expect(mutex.size).toBe(0);
  });

  it('limpeza: depois de muitas wallets, esperas e timeouts, o Map fica vazio', async () => {
    const mutex = new WalletMutex();
    await Promise.all(
      Array.from({ length: 200 }, async (_, i) => {
        const release = await mutex.acquire(`w-${i % 20}`, 5_000);
        await Bun.sleep(0);
        release!();
      }),
    );
    expect(mutex.size).toBe(0);
    const owner = await mutex.acquire(A, 0);
    expect(await Promise.all([mutex.acquire(A, 5), mutex.acquire(A, 10)])).toEqual([undefined, undefined]);
    owner!();
    expect(mutex.size).toBe(0);
  });
});
