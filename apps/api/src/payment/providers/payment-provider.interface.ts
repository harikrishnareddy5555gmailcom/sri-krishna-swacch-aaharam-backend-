import type { PaymentStatus } from '@vishkaraa/types';

export interface CreatePaymentOrderInput {
  paymentAttemptId: string;
  amount: number; // in paise
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}

export interface PaymentOrderResult {
  providerOrderId: string;
  status: PaymentStatus;
  rawResponse?: Record<string, unknown>;
}

// =============================================================================
// REFUND INTERFACES — Phase 09B
// =============================================================================
// Provider-neutral abstraction. Razorpay and Mock are adapters.
// Domain services NEVER import Razorpay SDK types directly.

export interface CreateProviderRefundInput {
  /** Local PaymentAttempt.id — for logging correlation */
  paymentAttemptId: string;
  /** Provider payment ID (e.g. "pay_29QQoUBi66xm2f") */
  providerPaymentId: string;
  /** Refund amount in integer paise */
  amount: number;
  /** ISO currency code ("INR") */
  currency: string;
  /** Human-readable receipt (RF-YYYYMM-XXXXXXXX) — passed to provider as receipt */
  receipt: string;
  /** Key-value notes forwarded to provider */
  notes?: Record<string, string>;
  /**
   * Globally unique idempotency key for this attempt.
   * Prevents double-charging if the network request is retried.
   * Format: ref_att_{refundId}_{attemptNumber}
   */
  idempotencyKey: string;
}

export interface ProviderRefundResult {
  /** Provider-assigned refund ID (e.g. "rfnd_29QQoUBi66xm2f") */
  providerRefundId: string;
  /** Normalized settlement status */
  status: 'PENDING' | 'PROCESSED' | 'FAILED';
  /** Full sanitized provider response for audit/debugging */
  rawResponse?: Record<string, unknown>;
  /** Provider error code if status = FAILED */
  errorCode?: string;
  /** Provider error message if status = FAILED */
  errorMessage?: string;
}

// =============================================================================
// PAYMENT PROVIDER INTERFACE
// =============================================================================

export interface PaymentProvider {
  readonly providerName: string;

  /**
   * Initializes or creates an order with the payment provider.
   * Must NOT throw raw provider network objects; returns standardized domain result.
   */
  createPaymentOrder(
    input: CreatePaymentOrderInput,
  ): Promise<PaymentOrderResult>;

  /**
   * Initiates a refund against a previously CAPTURED payment.
   *
   * CRITICAL: Must pass idempotencyKey to the provider to prevent double-refunding
   * if the network drops after the provider processes the request.
   *
   * On network timeout or HTTP 5xx: THROW rather than returning FAILED.
   * The caller (RefundService) will mark the attempt as RECONCILIATION_REQUIRED.
   *
   * @throws Error with sanitized message — never raw provider SDK error objects.
   */
  createRefund(input: CreateProviderRefundInput): Promise<ProviderRefundResult>;

  /**
   * Fetches the current status of a previously initiated refund.
   * Used by the reconciliation sweep to resolve ambiguous RECONCILIATION_REQUIRED attempts.
   *
   * @param providerRefundId — Provider-assigned refund ID (e.g. "rfnd_XXXXXX")
   * @param providerPaymentId — Provider-assigned payment ID (for providers that require it)
   * @throws Error if the provider is unreachable.
   */
  fetchRefund(
    providerRefundId: string,
    providerPaymentId?: string,
  ): Promise<ProviderRefundResult>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
