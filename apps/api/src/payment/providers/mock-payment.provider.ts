import { Injectable, Logger } from '@nestjs/common';
import { PaymentStatus } from '@vishkaraa/types';
import type {
  PaymentProvider,
  CreatePaymentOrderInput,
  PaymentOrderResult,
  CreateProviderRefundInput,
  ProviderRefundResult,
} from './payment-provider.interface.js';

/**
 * MockPaymentProvider — deterministic in-memory test double.
 *
 * Used exclusively in development and test environments.
 * Production environment guard: an application startup check in payment.module.ts
 * ensures MOCK is never activated when NODE_ENV === 'production'.
 *
 * Test injection hooks allow simulating all failure scenarios:
 *   - shouldFailOrderCreation: causes createPaymentOrder to throw
 *   - shouldFailRefund: causes createRefund to throw a gateway error
 *   - shouldTimeoutRefund: causes createRefund to throw a network timeout error
 *   - simulatedRefundStatus: controls what status fetchRefund returns
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly providerName = 'MOCK';
  private readonly logger = new Logger(MockPaymentProvider.name);

  // ─── Order creation hooks ───────────────────────────────────────────────────
  public shouldFailOrderCreation = false;
  public failureMessage = 'Simulated provider error';

  // ─── Refund hooks ───────────────────────────────────────────────────────────
  public shouldFailRefund = false;
  public shouldTimeoutRefund = false;
  public refundFailureMessage = 'Simulated refund gateway error';
  /** Controls what fetchRefund returns: 'PROCESSED' | 'FAILED' | 'PENDING' */
  public simulatedRefundStatus: 'PENDING' | 'PROCESSED' | 'FAILED' = 'PROCESSED';

  // ─── In-memory refund store (for idempotency testing) ──────────────────────
  private readonly _refundStore = new Map<string, ProviderRefundResult>();

  async createPaymentOrder(
    input: CreatePaymentOrderInput,
  ): Promise<PaymentOrderResult> {
    this.logger.debug(
      `MockPaymentProvider: Creating payment order for attempt ${input.paymentAttemptId}, amount ${input.amount} ${input.currency}`,
    );

    await Promise.resolve();

    if (this.shouldFailOrderCreation) {
      throw new Error(this.failureMessage);
    }

    const providerOrderId = `order_mock_${input.paymentAttemptId.replace(/-/g, '').slice(0, 16)}`;

    return {
      providerOrderId,
      status: PaymentStatus.PENDING,
    };
  }

  /**
   * Simulates a refund against a CAPTURED mock payment.
   *
   * Idempotency: If the same idempotencyKey is submitted twice, returns the same
   * stored result without re-executing — mirrors Razorpay behavior.
   *
   * @throws Error on shouldTimeoutRefund (for RECONCILIATION_REQUIRED testing)
   * @throws Error on shouldFailRefund (for FAILED gateway testing)
   */
  async createRefund(input: CreateProviderRefundInput): Promise<ProviderRefundResult> {
    this.logger.debug(
      `MockPaymentProvider: Creating refund for payment ${input.providerPaymentId}, amount ${input.amount} ${input.currency}, idempotencyKey ${input.idempotencyKey}`,
    );

    await Promise.resolve();

    // Idempotency: return stored result if key was already processed
    const stored = this._refundStore.get(input.idempotencyKey);
    if (stored) {
      this.logger.debug(`MockPaymentProvider: Returning idempotent refund result for key ${input.idempotencyKey}`);
      return stored;
    }

    if (this.shouldTimeoutRefund) {
      // Simulates a network timeout — caller should mark as RECONCILIATION_REQUIRED
      throw new Error('Mock provider: simulated network timeout during refund');
    }

    if (this.shouldFailRefund) {
      // Simulates a permanent gateway rejection
      const result: ProviderRefundResult = {
        providerRefundId: `rfnd_mock_fail_${Date.now()}`,
        status: 'FAILED',
        errorCode: 'MOCK_GATEWAY_REJECTION',
        errorMessage: this.refundFailureMessage,
        rawResponse: { mock: true, failed: true },
      };
      this._refundStore.set(input.idempotencyKey, result);
      return result;
    }

    const providerRefundId = `rfnd_mock_${input.idempotencyKey.replace(/[^a-z0-9]/gi, '').slice(0, 14)}`;
    const result: ProviderRefundResult = {
      providerRefundId,
      status: 'PROCESSED',
      rawResponse: { mock: true, amount: input.amount, currency: input.currency },
    };

    this._refundStore.set(input.idempotencyKey, result);
    return result;
  }

  /**
   * Fetches the current status of a previously initiated refund.
   * Returns simulatedRefundStatus (configurable for reconciliation tests).
   */
  async fetchRefund(
    providerRefundId: string,
    _providerPaymentId?: string,
  ): Promise<ProviderRefundResult> {
    this.logger.debug(
      `MockPaymentProvider: Fetching refund status for ${providerRefundId}`,
    );

    await Promise.resolve();

    if (this.shouldTimeoutRefund) {
      throw new Error('Mock provider: simulated network timeout during fetchRefund');
    }

    return {
      providerRefundId,
      status: this.simulatedRefundStatus,
      rawResponse: { mock: true, providerRefundId, fetched: true },
    };
  }

  /** Reset all test hooks to defaults — call in beforeEach() */
  resetHooks(): void {
    this.shouldFailOrderCreation = false;
    this.shouldFailRefund = false;
    this.shouldTimeoutRefund = false;
    this.failureMessage = 'Simulated provider error';
    this.refundFailureMessage = 'Simulated refund gateway error';
    this.simulatedRefundStatus = 'PROCESSED';
    this._refundStore.clear();
  }
}
