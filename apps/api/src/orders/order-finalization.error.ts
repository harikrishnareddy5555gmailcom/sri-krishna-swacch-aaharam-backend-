/**
 * VISHKARAA — ORDER FINALIZATION ERROR
 *
 * Typed error class for all order finalization failures.
 * Distinguishes between recoverable and non-recoverable conditions.
 */

export type OrderFinalizationErrorCode =
  | 'ATTEMPT_NOT_FOUND'
  | 'ATTEMPT_NOT_CAPTURED'
  | 'REQUIRES_RECONCILIATION'
  | 'EMPTY_SNAPSHOT'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'LINEITEM_INTEGRITY'
  | 'ORDER_NUMBER_EXHAUSTED';

export class OrderFinalizationError extends Error {
  constructor(
    public readonly code: OrderFinalizationErrorCode,
    message?: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'OrderFinalizationError';
  }
}
