/**
 * Códigos de falha estáveis e legíveis por máquina (contrato público: nunca renomeie,
 * só acrescente). Significado e ação esperada do provedor em ARCHITECTURE.md → "Taxonomia de failureCode".
 */
export enum FailureCode {
  /** BET sem saldo suficiente. */
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  /** REFUND/ROLLBACK cuja aplicação deixaria o saldo negativo. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** Prazo (TTL a partir do createdAt) de PENDING_REFERENCE esgotado sem a referência resolvida: ausente ou ainda pendente. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência terminou REJECTED ou FAILED (PENDING/PENDING_REFERENCE significam aguardar). */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** REFUND, WIN ou LOSS que não referencia BET, ou ROLLBACK que não referencia BET/WIN/REFUND. */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** A referência já tem REFUND/ROLLBACK processado (vale para reversões e para WIN/LOSS sobre BET estornada). */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  ReferenceRoundMismatch = 'REFERENCE_ROUND_MISMATCH',
  ReferencePlayerMismatch = 'REFERENCE_PLAYER_MISMATCH',
  ReferenceWalletMismatch = 'REFERENCE_WALLET_MISMATCH',
  /** Erro permanente de infraestrutura (status FAILED). */
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
  /** Crédito que levaria o saldo além do limite do numeric(20,2) (18 dígitos inteiros). */
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
}
