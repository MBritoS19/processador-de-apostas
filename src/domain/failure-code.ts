/**
 * Códigos de falha estáveis e legíveis por máquina (contrato público: nunca renomeie,
 * só acrescente). Significado e ação esperada do provedor em ARCHITECTURE.md.
 */
export enum FailureCode {
  /** BET sem saldo suficiente. */
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  /** REFUND/ROLLBACK cuja aplicação deixaria o saldo negativo. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** Referência não apareceu dentro do limite de tentativas de PENDING_REFERENCE. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência terminou REJECTED ou FAILED (PENDING/PENDING_REFERENCE significam aguardar). */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** REFUND que não referencia BET, ou ROLLBACK que não referencia BET/WIN/REFUND. */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  ReferenceRoundMismatch = 'REFERENCE_ROUND_MISMATCH',
  ReferencePlayerMismatch = 'REFERENCE_PLAYER_MISMATCH',
  ReferenceWalletMismatch = 'REFERENCE_WALLET_MISMATCH',
  /** Erro permanente de infraestrutura (status FAILED). */
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
}
