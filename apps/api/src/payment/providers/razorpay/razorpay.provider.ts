/**
 * RazorpayPaymentProvider
 *
 * Implements the provider-independent PaymentProvider interface using Razorpay.
 *
 * Design invariants:
 * - Raw Razorpay SDK response objects are NEVER passed to domain services or controllers.
 * - All SDK errors are caught and mapped to domain Error objects before re-throwing.
 * - Credentials are read exclusively from environment variables at construction time.
 * - No retry logic inside the provider — callers own retry/idempotency policy.
 * - For refunds: network timeouts are re-thrown as-is so the caller can mark
 *   the attempt as RECONCILIATION_REQUIRED (never silently mark as FAILED).
 */

import { Injectable, Logger } from '@nestjs/common';
import Razorpay from 'razorpay';
import type {
  PaymentProvider,
  CreatePaymentOrderInput,
  PaymentOrderResult,
  CreateProviderRefundInput,
  ProviderRefundResult,
} from '../payment-provider.interface.js';
import { PaymentStatus } from '@vishkaraa/types';

/** Razorpay SDK raw refund shape (only fields we actually use) */
interface RazorpayRefundRaw {
  id: string;
  status: string; // 'pending' | 'processed' | 'failed'
  error_code?: string;
  error_description?: string;
  [key: string]: unknown;
}

function mapRazorpayRefundStatus(
  rzpStatus: string,
): 'PENDING' | 'PROCESSED' | 'FAILED' {
  switch (rzpStatus?.toLowerCase()) {
    case 'processed': return 'PROCESSED';
    case 'failed':    return 'FAILED';
    default:          return 'PENDING';
  }
}

@Injectable()
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly providerName = 'RAZORPAY';

  private readonly logger = new Logger(RazorpayPaymentProvider.name);
  private readonly client: Razorpay;

  constructor() {
    const keyId = process.env['RAZORPAY_KEY_ID'];
    const keySecret = process.env['RAZORPAY_KEY_SECRET'];

    if (!keyId || !keySecret) {
      throw new Error(
        'FATAL: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in environment variables before activating RazorpayPaymentProvider.',
      );
    }

    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }

  /**
   * Creates a Razorpay Order for the given payment attempt.
   *
   * Razorpay Order is a pre-requisite to initiating payment collection on the frontend.
   * The returned providerOrderId must be passed to the Razorpay checkout SDK on the client.
   *
   * @throws Error with a sanitised message (no raw Razorpay internals exposed)
   */
  async createPaymentOrder(
    input: CreatePaymentOrderInput,
  ): Promise<PaymentOrderResult> {
    this.logger.log(
      `Creating Razorpay order for attempt ${input.paymentAttemptId} — amount: ${input.amount} ${input.currency}`,
    );

    let rawOrder: { id: string; status: string };

    try {
      // Razorpay SDK createOrder returns a RazorpayOrder object
      rawOrder = await this.client.orders.create({
        amount: input.amount, // already in paise
        currency: input.currency,
        receipt: input.receipt.slice(0, 40), // Razorpay receipt max length 40
        notes: input.notes ?? {},
      });
    } catch (sdkError: unknown) {
      // Map SDK/network error to safe domain error — never expose raw SDK error objects
      const safeMessage =
        sdkError instanceof Error
          ? sdkError.message
          : 'Razorpay order creation failed due to an internal provider error.';

      this.logger.error(
        `Razorpay SDK error for attempt ${input.paymentAttemptId}: ${safeMessage}`,
      );

      throw new Error(`Razorpay provider error: ${safeMessage}`, { cause: sdkError });
    }

    if (!rawOrder?.id) {
      throw new Error('Razorpay order creation returned an invalid response (missing id).');
    }

    this.logger.log(
      `Razorpay order created: ${rawOrder.id} for attempt ${input.paymentAttemptId}`,
    );

    return {
      providerOrderId: rawOrder.id,
      // Razorpay orders start in "created" status; map to domain PENDING
      status: PaymentStatus.PENDING,
    };
  }

  /**
   * Initiates a refund against a previously CAPTURED Razorpay payment.
   *
   * CRITICAL INVARIANT: On network timeout or HTTP 5xx, this method THROWS rather
   * than returning FAILED. The caller (RefundService) must catch and mark the
   * attempt as RECONCILIATION_REQUIRED — because Razorpay may have processed the
   * refund before the connection dropped.
   *
   * Idempotency: Razorpay uses the receipt field for idempotency on its end.
   * We pass input.idempotencyKey as the receipt (truncated to 40 chars).
   */
  async createRefund(input: CreateProviderRefundInput): Promise<ProviderRefundResult> {
    this.logger.log(
      `Creating Razorpay refund for payment ${input.providerPaymentId}, amount ${input.amount} ${input.currency}, key ${input.idempotencyKey}`,
    );

    let rawRefund: RazorpayRefundRaw;

    try {
      rawRefund = (await (this.client.payments.refund(
        input.providerPaymentId,
        {
          amount: input.amount,
          notes: {
            ...(input.notes ?? {}),
            receipt: input.receipt.slice(0, 40),
          },
        },
      ) as unknown)) as RazorpayRefundRaw;
    } catch (sdkError: unknown) {
      const safeMessage =
        sdkError instanceof Error
          ? sdkError.message
          : 'Razorpay refund failed due to an internal provider error.';

      this.logger.error(
        `Razorpay refund SDK error for payment ${input.providerPaymentId}: ${safeMessage}`,
      );

      // RE-THROW so caller can decide: permanent FAILED vs RECONCILIATION_REQUIRED
      throw new Error(`Razorpay refund provider error: ${safeMessage}`, { cause: sdkError });
    }

    if (!rawRefund?.id) {
      throw new Error('Razorpay refund returned an invalid response (missing id).');
    }

    const status = mapRazorpayRefundStatus(rawRefund.status);

    this.logger.log(
      `Razorpay refund created: ${rawRefund.id} (status: ${status}) for payment ${input.providerPaymentId}`,
    );

    return {
      providerRefundId: rawRefund.id,
      status,
      rawResponse: {
        id: rawRefund.id,
        status: rawRefund.status,
        // Never include credentials, keys, or secrets here
      },
      errorCode: rawRefund.error_code,
      errorMessage: rawRefund.error_description,
    };
  }

  /**
   * Fetches the current status of a previously initiated Razorpay refund.
   * Used by the reconciliation sweep for RECONCILIATION_REQUIRED attempts.
   */
  async fetchRefund(
    providerRefundId: string,
    _providerPaymentId?: string,
  ): Promise<ProviderRefundResult> {
    this.logger.log(`Fetching Razorpay refund status for ${providerRefundId}`);

    let rawRefund: RazorpayRefundRaw;

    try {
      rawRefund = (await (this.client.refunds.fetch(
        providerRefundId,
      ) as unknown)) as RazorpayRefundRaw;
    } catch (sdkError: unknown) {
      const safeMessage =
        sdkError instanceof Error
          ? sdkError.message
          : 'Razorpay fetchRefund failed due to an internal provider error.';

      this.logger.error(
        `Razorpay fetchRefund SDK error for ${providerRefundId}: ${safeMessage}`,
      );

      throw new Error(`Razorpay fetchRefund provider error: ${safeMessage}`, { cause: sdkError });
    }

    if (!rawRefund?.id) {
      throw new Error(`Razorpay fetchRefund returned an invalid response for ${providerRefundId}.`);
    }

    const status = mapRazorpayRefundStatus(rawRefund.status);

    return {
      providerRefundId: rawRefund.id,
      status,
      rawResponse: { id: rawRefund.id, status: rawRefund.status },
      errorCode: rawRefund.error_code,
      errorMessage: rawRefund.error_description,
    };
  }
}
