import { Migration } from '@mikro-orm/migrations';

const BASE_CODES = [
  'INSUFFICIENT_BALANCE',
  'REVERSAL_WOULD_OVERDRAW',
  'WALLET_NOT_FOUND',
  'WALLET_PLAYER_MISMATCH',
  'CURRENCY_MISMATCH',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_NOT_PROCESSED',
  'INVALID_REFERENCE_KIND',
  'REFERENCE_ALREADY_REVERSED',
  'AMOUNT_MISMATCH',
  'REFERENCE_ROUND_MISMATCH',
  'REFERENCE_PLAYER_MISMATCH',
  'REFERENCE_WALLET_MISMATCH',
  'INFRASTRUCTURE_FAILURE',
];

const check = (codes: string[]) =>
  `alter table wager_transactions add constraint ck_wager_tx_failure_code check (failure_code in (${codes
    .map((code) => `'${code}'`)
    .join(',')}))`;

/** Novo FailureCode BALANCE_LIMIT_EXCEEDED: crédito que passaria do limite do numeric(20,2). */
export class Migration20261107310000_balance_limit_failure_code extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table wager_transactions drop constraint ck_wager_tx_failure_code');
    this.addSql(check([...BASE_CODES, 'BALANCE_LIMIT_EXCEEDED']));
  }

  /** Falha se já houver transações com o código novo (não há como "desrejeitá-las"). */
  override async down(): Promise<void> {
    this.addSql('alter table wager_transactions drop constraint ck_wager_tx_failure_code');
    this.addSql(check(BASE_CODES));
  }
}
