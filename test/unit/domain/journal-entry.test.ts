import { describe, expect, test } from 'bun:test';
import { InvalidJournalEntryError } from '../../../src/domain/errors';
import { AccountKind, JournalEntry, type JournalEntryState, type Posting } from '../../../src/domain/journal-entry';
import { Money } from '../../../src/domain/money';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind as Kind,
} from '../../../src/domain/wager-transaction';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry';
import { T0, brl, newTransaction } from './fixtures';

const { Debit, Credit } = LedgerDirection;
const player = { kind: AccountKind.Player, walletId: 'wallet-1' } as const;
const house = { kind: AccountKind.ProviderHouse, providerId: 'provider-1' } as const;
const funding = { kind: AccountKind.Funding } as const;

const leg = (account: Posting['account'], direction: LedgerDirection, amount: string): Posting => ({
  account,
  direction,
  money: brl(amount),
});

const state = (postings: Posting[], overrides: Partial<JournalEntryState> = {}): JournalEntryState => ({
  id: 'journal-1',
  transactionId: 'tx-1',
  currency: 'BRL',
  postings,
  createdAt: T0,
  ...overrides,
});

/** Lançamento da wallet com a direção que o domínio daria à transação. */
function ledgerFor(tx: WagerTransaction, reference?: WagerTransaction): WalletLedgerEntry {
  const direction = tx.ledgerDirectionFor(reference);
  const before = brl('100.00');
  return WalletLedgerEntry.create({
    id: 'entry-1',
    walletId: tx.walletId,
    transactionId: tx.id,
    direction,
    money: tx.money,
    balanceBefore: before,
    balanceAfter: direction === Credit ? before.add(tx.money) : before.subtract(tx.money),
    createdAt: T0,
  });
}

describe('JournalEntry.create — partidas dobradas', () => {
  test('débito = crédito é aceito', () => {
    const entry = JournalEntry.create(state([leg(player, Debit, '30.00'), leg(house, Credit, '30.00')]));
    expect(entry.isBalanced()).toBe(true);
  });

  test('aceita mais de duas pernas quando fecha', () => {
    const entry = JournalEntry.create(
      state([leg(player, Debit, '30.00'), leg(house, Credit, '20.00'), leg(funding, Credit, '10.00')]),
    );
    expect(entry.postings).toHaveLength(3);
  });

  test.each([
    ['desbalanceado', state([leg(player, Debit, '30.00'), leg(house, Credit, '29.99')])],
    ['uma perna só', state([leg(player, Debit, '30.00')])],
    ['sem crédito', state([leg(player, Debit, '30.00'), leg(house, Debit, '30.00')])],
    ['sem débito', state([leg(player, Credit, '30.00'), leg(house, Credit, '30.00')])],
    ['perna zero', state([leg(player, Debit, '0'), leg(house, Credit, '0')])],
    [
      'moeda mista',
      state([
        leg(player, Debit, '30.00'),
        { account: house, direction: Credit, money: Money.from({ amount: '30.00', currency: 'USD' }) },
      ]),
    ],
    ['moeda do lançamento diferente das pernas', state([leg(player, Debit, '30.00'), leg(house, Credit, '30.00')], { currency: 'USD' })],
  ])('rejeita %s', (_label, invalid) => {
    expect(() => JournalEntry.create(invalid)).toThrow(InvalidJournalEntryError);
  });
});

describe('JournalEntry — imutabilidade', () => {
  test('instância, pernas e contas são congeladas', () => {
    const entry = JournalEntry.create(state([leg(player, Debit, '30.00'), leg(house, Credit, '30.00')]));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.postings)).toBe(true);
    expect(Object.isFrozen(entry.postings[0])).toBe(true);
    expect(Object.isFrozen(entry.postings[0]!.account)).toBe(true);
  });

  test('não compartilha o array de entrada', () => {
    const postings = [leg(player, Debit, '30.00'), leg(house, Credit, '30.00')];
    const entry = JournalEntry.create(state(postings));
    postings.push(leg(funding, Credit, '1.00'));
    expect(entry.postings).toHaveLength(2);
  });

  test('rehydrate não revalida', () => {
    const entry = JournalEntry.rehydrate(state([leg(player, Debit, '30.00'), leg(house, Credit, '1.00')]));
    expect(entry.isBalanced()).toBe(false);
  });
});

describe('JournalEntry.forTransaction — lançamento por kind', () => {
  const opening = WagerTransaction.opening({
    id: 'tx-1',
    providerId: INTERNAL_PROVIDER_ID,
    externalTransactionId: 'opening:wallet-1',
    idempotencyKey: 'opening:wallet-1',
    payloadHash: 'hash',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'opening',
    gameId: 'system',
    kind: Kind.Opening,
    money: brl('10.00'),
    createdAt: T0,
  });
  const ref = (kind: Kind) =>
    newTransaction({
      id: 'ref-1',
      externalTransactionId: 'ext-ref',
      kind,
      ...(kind === Kind.Refund && { referenceExternalTransactionId: 'ext-bet' }),
    });
  const withRef = (kind: Kind) => newTransaction({ kind, referenceExternalTransactionId: 'ext-ref' });

  type Case = [label: string, tx: WagerTransaction, reference: WagerTransaction | undefined, debit: Posting['account'], credit: Posting['account']];
  const cases: Case[] = [
    ['OPENING', opening, undefined, funding, player],
    ['BET', newTransaction({ kind: Kind.Bet }), undefined, player, house],
    ['WIN', newTransaction({ kind: Kind.Win }), undefined, house, player],
    ['REFUND', withRef(Kind.Refund), ref(Kind.Bet), house, player],
    ['ROLLBACK de BET', withRef(Kind.Rollback), ref(Kind.Bet), house, player],
    ['ROLLBACK de WIN', withRef(Kind.Rollback), ref(Kind.Win), player, house],
    ['ROLLBACK de REFUND', withRef(Kind.Rollback), ref(Kind.Refund), player, house],
  ];

  test.each(cases)('%s', (_label, tx, reference, debit, credit) => {
    const ledger = ledgerFor(tx, reference);
    const entry = JournalEntry.forTransaction('journal-1', tx, ledger);

    expect(entry.transactionId).toBe(tx.id);
    expect(entry.currency).toBe('BRL');
    expect(entry.createdAt).toEqual(ledger.createdAt);
    expect(entry.postings).toEqual([
      expect.objectContaining({ direction: ledger.direction }),
      expect.anything(),
    ]);
    const debits = entry.postings.filter((p) => p.direction === Debit);
    const credits = entry.postings.filter((p) => p.direction === Credit);
    expect(debits.map((p) => p.account)).toEqual([debit]);
    expect(credits.map((p) => p.account)).toEqual([credit]);
    expect(entry.postings.every((p) => p.money.equals(tx.money))).toBe(true);
    expect(entry.isBalanced()).toBe(true);
  });

  test('a contrapartida é a conta do provider da transação', () => {
    const tx = newTransaction({ kind: Kind.Bet, providerId: 'provider-2' });
    const entry = JournalEntry.forTransaction('journal-1', tx, ledgerFor(tx));
    expect(entry.postings[1]!.account).toEqual({ kind: AccountKind.ProviderHouse, providerId: 'provider-2' });
  });

  test('rejeita lançamento da wallet de outra transação', () => {
    const tx = newTransaction({ kind: Kind.Bet });
    const other = ledgerFor(newTransaction({ id: 'tx-2', kind: Kind.Bet }));
    expect(() => JournalEntry.forTransaction('journal-1', tx, other)).toThrow(InvalidJournalEntryError);
  });

  test('rejeita lançamento da wallet de outra wallet', () => {
    const tx = newTransaction({ kind: Kind.Bet });
    const other = ledgerFor(newTransaction({ kind: Kind.Bet, walletId: 'wallet-2' }));
    expect(() => JournalEntry.forTransaction('journal-1', tx, other)).toThrow(InvalidJournalEntryError);
  });

  test('rejeita lançamento da wallet com outro valor', () => {
    const tx = newTransaction({ kind: Kind.Bet });
    const other = ledgerFor(newTransaction({ kind: Kind.Bet, money: brl('11.00') }));
    expect(() => JournalEntry.forTransaction('journal-1', tx, other)).toThrow(InvalidJournalEntryError);
  });
});
