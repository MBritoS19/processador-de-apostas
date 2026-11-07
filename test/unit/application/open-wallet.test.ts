import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  TransientPersistenceError,
  UniqueViolationError,
  type WagerProcessingRepository,
  type WagerUnitOfWork,
} from '../../../src/application/ports/wager-unit-of-work';
import { OpenWallet } from '../../../src/application/wallets/open-wallet';

/** UoW falso: a 1ª chamada lança `first`; as seguintes rodam o trabalho com `findWalletIdByPlayer` fixo. */
function fakeUnitOfWork(first: Error, existingId?: string): WagerUnitOfWork & { calls: number } {
  return {
    calls: 0,
    async run<T>(work: (repository: WagerProcessingRepository) => Promise<T>): Promise<T> {
      if (this.calls++ === 0) throw first;
      return work({ findWalletIdByPlayer: async () => existingId } as unknown as WagerProcessingRepository);
    },
  };
}

const command = (overrides: Record<string, unknown> = {}) => ({
  playerId: 'p1',
  initialBalance: { amount: '10.00', currency: 'BRL' },
  correlationId: 'corr-1',
  ...overrides,
});

const useCase = (unitOfWork: WagerUnitOfWork) => new OpenWallet(unitOfWork, { now: () => new Date(0) }, { uuid: randomUUID });

describe('OpenWallet', () => {
  it('unicidade de (player, moeda) → WalletAlreadyExists com o id existente', async () => {
    const unitOfWork = fakeUnitOfWork(new UniqueViolationError('wallet'), 'wallet-existente');
    expect(await useCase(unitOfWork).execute(command())).toEqual({ type: 'WalletAlreadyExists', existingWalletId: 'wallet-existente' });
  });

  it('falha transitória → TransientFailure (nunca InvalidInput)', async () => {
    const unitOfWork = fakeUnitOfWork(new TransientPersistenceError('unavailable'));
    expect(await useCase(unitOfWork).execute(command())).toEqual({ type: 'TransientFailure', reason: 'unavailable' });
  });

  it('erro inesperado do banco é relançado (vira 500 na borda)', async () => {
    const unitOfWork = fakeUnitOfWork(new Error('relation "wallets" does not exist'));
    await expect(useCase(unitOfWork).execute(command())).rejects.toThrow('relation');
  });

  it.each([
    ['playerId vazio', { playerId: '' }],
    ['playerId acima de 256', { playerId: 'x'.repeat(257) }],
    ['initialBalance ausente', { initialBalance: undefined }],
    ['amount number', { initialBalance: { amount: 10, currency: 'BRL' } }],
    ['amount negativo', { initialBalance: { amount: '-1.00', currency: 'BRL' } }],
  ])('%s → InvalidInput sem abrir transação', async (_name, overrides) => {
    const unitOfWork = fakeUnitOfWork(new Error('não deveria abrir transação'));
    expect((await useCase(unitOfWork).execute(command(overrides))).type).toBe('InvalidInput');
    expect(unitOfWork.calls).toBe(0);
  });
});
