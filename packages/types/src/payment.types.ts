/**
 * Payment Domain Types
 *
 * Domain types for Provider-Independent Payment Architecture.
 *
 * Design Principles:
 * - Server is authoritative: amount and currency are derived directly from
 *   authoritative CheckoutSession validation (assertCheckoutReadyForPayment).
 *   Client-provided amounts, subtotals, and currencies are strictly ignored.
 * - Explicit payment status state machine:
 *     CREATED -> PENDING -> AUTHORIZED -> CAPTURED
 *     CREATED -> CANCELLED
 *     PENDING -> CANCELLED
 *     PENDING -> FAILED
 *     FAILED/CANCELLED + provider CAPTURED -> REQUIRES_RECONCILIATION
 * - REQUIRES_RECONCILIATION: Terminal state. Money captured by provider while local
 *   state was FAILED/CANCELLED. Requires admin investigation. Phase 08 must not
 *   treat this as a normal CAPTURED payment.
 * - Provider-independent: Domain business layer only interacts with standard
 *   types (provider, providerOrderId, providerPaymentId, etc.), never raw provider SDK objects.
 * - Card/credential privacy: No PAN, CVV, PIN, or provider secret tokens are ever stored.
 * - Integer minor-unit monetary arithmetic (paise for INR).
 */

export enum PaymentStatus {
  CREATED = 'CREATED',
  PENDING = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  CAPTURED = 'CAPTURED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  /**
   * REQUIRES_RECONCILIATION: Set when the payment provider reports CAPTURED
   * but local state is FAILED or CANCELLED.
   *
   * This is a sentinel state visible to admins.
   * Phase 08 MUST NOT treat this as a normal CAPTURED payment.
   * Do not attempt automatic refund — requires explicit refund infrastructure.
   */
  REQUIRES_RECONCILIATION = 'REQUIRES_RECONCILIATION',
}

export interface PaymentAttemptDto {
  id: string;
  userId: string;
  checkoutSessionId: string;
  amount: number; // in paise
  currency: string;
  status: PaymentStatus;
  provider: string;
  providerOrderId?: string | null;
  providerPaymentId?: string | null;
  idempotencyKey?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePaymentAttemptInput {
  checkoutSessionId: string;
  idempotencyKey?: string;
  resetActive?: boolean;
}
