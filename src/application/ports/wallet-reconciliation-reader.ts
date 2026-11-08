/** Lançamento da wallet com a transação a que ele aponta (ausente se a transação não existir). */
export interface ReconciliationEntryRow {
  entryId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  transaction?: { walletId: string; kind: string; status: string; amount: string; currency: string; referenceKind?: string };
}

/** Transação PROCESSED da wallet com quantos lançamentos ela tem, em qualquer wallet. */
export interface ReconciliationTransactionRow {
  transactionId: string;
  kind: string;
  entries: number;
}

/** Fotografia de uma wallet para a reconciliação, lida num único snapshot. */
export interface WalletReconciliationSnapshot {
  balance: string;
  currency: string;
  entries: ReconciliationEntryRow[];
  processed: ReconciliationTransactionRow[];
}

/**
 * Leitura sem lock e sem escrita: a reconciliação nunca corrige nada. As três leituras vêm do
 * mesmo snapshot (REPEATABLE READ), senão um commit no meio geraria falsa divergência.
 */
export interface WalletReconciliationReader {
  /** `undefined` se a wallet não existe. */
  read(walletId: string): Promise<WalletReconciliationSnapshot | undefined>;
}
