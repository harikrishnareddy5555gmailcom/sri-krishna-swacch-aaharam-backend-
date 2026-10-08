/**
 * WebhookService
 *
 * Domain service responsible for:
 * 1. Idempotency deduplication of inbound webhook events.
 * 2. Amount/currency integrity validation before financial transitions.
 * 3. Mapping provider events to domain PaymentStatus transitions.
 * 4. Reconciliation: detecting FAILED/CANCELLED + provider CAPTURED mismatch.
 * 5. Persisting WebhookEvent records for audit and replay.
 * 6. Calling PaymentService.transitionStatusSystem to advance the state machine.
 *
 * SECURITY:
 * - This service does NOT perform signature verification. That is the responsibility
 *   of WebhookController (HTTP boundary), which must verify the signature BEFORE
 *   calling any method on this service.
 * - Raw provider payloads are stored in `rawPayload` for audit purposes.
 * - Amount/currency from provider webhook are compared to local authoritative values
 *   before any financial state transition is applied.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PaymentService } from './payment.service.js';
import {
  PaymentStateMachine,
  TransitionEvaluationResult,
} from './state/payment-state-machine.js';
import { PaymentStatus, AuditAction, AuditEntityType } from '@vishkaraa/types';
import type {
  ParsedRazorpayWebhookEvent,
  RazorpayWebhookEventType,
} from './providers/razorpay/razorpay-webhook.types.js';

import { OrderService } from '../orders/orders.service.js';

/** Maps Razorpay event types to domain PaymentStatus */
function mapEventToStatus(
  eventType: RazorpayWebhookEventType,
): PaymentStatus | null {
  switch (eventType) {
    case 'payment.authorized':
      return PaymentStatus.AUTHORIZED;
    case 'payment.captured':
    case 'order.paid':
      return PaymentStatus.CAPTURED;
    case 'payment.failed':
      return PaymentStatus.FAILED;
    default:
      return null;
  }
}

/**
 * Event types that carry amount/currency and represent a financial success.
 * These MUST pass amount/currency integrity checks before being applied.
 */
const FINANCIAL_SUCCESS_EVENTS = new Set<RazorpayWebhookEventType>([
  'payment.captured',
  'order.paid',
  'payment.authorized',
]);

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly paymentService: PaymentService,
    private readonly orderService?: OrderService,
  ) {}

  /**
   * Processes a parsed, signature-verified Razorpay webhook event.
   *
   * @param provider  Provider name (e.g. "RAZORPAY")
   * @param eventId   Provider-supplied unique event ID (used for idempotency)
   * @param event     Parsed webhook event (domain-safe, no raw SDK objects)
   * @param rawPayload The raw JSON payload (stored for audit)
   *
   * @returns 'PROCESSED' | 'DUPLICATE' | 'IGNORED' | 'RECONCILIATION_REQUIRED'
   */
  async processWebhookEvent(
    provider: string,
    eventId: string,
    event: ParsedRazorpayWebhookEvent,
    rawPayload: Record<string, unknown>,
  ): Promise<'PROCESSED' | 'DUPLICATE' | 'IGNORED' | 'RECONCILIATION_REQUIRED'> {
    // ── 1. Idempotency Gate: attempt to create the WebhookEvent record ──────
    let webhookEventId: string;

    try {
      const created = await this.prisma.webhookEvent.create({
        data: {
          provider,
          eventId,
          eventType: event.eventType,
          rawPayload: rawPayload as Prisma.InputJsonValue,
          processedAt: null,
        },
      });
      webhookEventId = created.id;
    } catch (err: unknown) {
      // P2002 = unique constraint violation on (provider, eventId)
      if (
        err instanceof Error &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        this.logger.log(
          `Webhook event ${eventId} (${event.eventType}) from ${provider} is a duplicate — safe no-op`,
        );
        return 'DUPLICATE';
      }
      throw err;
    }

    // ── 2. Map event to target domain status ────────────────────────────────
    const targetStatus = mapEventToStatus(event.eventType);

    if (!targetStatus) {
      this.logger.log(
        `Webhook event ${eventId} type "${event.eventType}" is not a handled payment transition — ignoring`,
      );
      await this.markProcessed(webhookEventId);
      return 'IGNORED';
    }

    // ── 3. Locate the PaymentAttempt by providerOrderId ─────────────────────
    const razorpayOrderId = event.razorpayOrderId;
    if (!razorpayOrderId) {
      this.logger.warn(
        `Webhook event ${eventId} (${event.eventType}) contains no razorpay order ID — cannot locate PaymentAttempt`,
      );
      await this.markProcessed(webhookEventId);
      return 'IGNORED';
    }

    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { providerOrderId: razorpayOrderId },
    });

    if (!attempt) {
      // May arrive before attempt is created or for unknown orders; log and ignore
      this.logger.warn(
        `Webhook event ${eventId} (${event.eventType}) references unknown Razorpay order ${razorpayOrderId}`,
      );
      await this.markProcessed(webhookEventId);
      return 'IGNORED';
    }

    // ── 4. Link WebhookEvent to PaymentAttempt ──────────────────────────────
    await this.prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { paymentAttemptId: attempt.id },
    });

    // ── 5. Amount/Currency Integrity Validation ──────────────────────────────
    // For financial success events, provider-reported amount and currency MUST
    // match the local authoritative values stored at PaymentAttempt creation.
    // Missing amount/currency is treated as a validation failure (not assumed valid).
    if (FINANCIAL_SUCCESS_EVENTS.has(event.eventType)) {
      const integrityResult = await this.validateAmountAndCurrency(
        event,
        attempt,
        webhookEventId,
        provider,
        eventId,
      );
      if (integrityResult !== 'OK') {
        await this.markProcessed(webhookEventId);
        return 'PROCESSED'; // Event was handled (rejected for integrity), don't retry
      }
    }

    // ── 6. State machine evaluation ─────────────────────────────────────────
    const currentStatus = attempt.status as PaymentStatus;
    const evaluationResult = PaymentStateMachine.evaluateTransition(
      currentStatus,
      targetStatus,
    );

    if (
      evaluationResult === TransitionEvaluationResult.NO_OP_DUPLICATE ||
      evaluationResult === TransitionEvaluationResult.NO_OP_STALE_EVENT
    ) {
      this.logger.log(
        `Webhook event ${eventId}: payment ${attempt.id} already in ${currentStatus}, target ${targetStatus} — ${evaluationResult} (safe no-op)`,
      );
      if (this.orderService && currentStatus === PaymentStatus.CAPTURED) {
        try {
          await this.orderService.finalizeFromPayment(attempt.id);
        } catch (orderError) {
          this.logger.error(
            `[CRITICAL] Order finalization retry failed on duplicate webhook for payment attempt ${attempt.id}: ${(orderError as Error).message}`,
          );
        }
      }
      await this.markProcessed(webhookEventId);
      return 'PROCESSED';
    }

    // ── 7. Reconciliation: provider captured but local state is terminal failure ──
    if (evaluationResult === TransitionEvaluationResult.REQUIRES_RECONCILIATION) {
      return this.handleReconciliation(
        attempt,
        webhookEventId,
        provider,
        eventId,
        event,
        currentStatus,
      );
    }

    if (evaluationResult === TransitionEvaluationResult.INVALID_TRANSITION) {
      this.logger.error(
        `Webhook event ${eventId}: INVALID transition ${currentStatus} → ${targetStatus} for payment ${attempt.id}`,
      );
      await this.auditService.logEvent({
        actorId: 'SYSTEM',
        actorRole: 'SYSTEM',
        actorEmail: `webhook:${provider}:${eventId}`,
        action: AuditAction.PAYMENT_SECURITY_VIOLATION,
        entityType: AuditEntityType.PAYMENT,
        entityId: attempt.id,
        metadata: {
          webhookEventId,
          eventType: event.eventType,
          from: currentStatus,
          to: targetStatus,
          reason: 'INVALID_STATE_TRANSITION_FROM_WEBHOOK',
        },
      });
      await this.markProcessed(webhookEventId);
      return 'PROCESSED';
    }

    // ── 8. Apply state transition (optimistic concurrency) ───────────────────
    // transitionStatusSystem uses a WHERE-clause version check to prevent
    // concurrent webhooks from overwriting a more-advanced state.
    await this.paymentService.transitionStatusSystem(
      attempt.id,
      targetStatus,
      `webhook:${provider}:${eventId}`,
      {
        providerPaymentId: event.razorpayPaymentId ?? undefined,
        failureCode: event.failureCode ?? undefined,
        failureMessage: event.failureMessage ?? undefined,
      },
    );

    // ── 9. Finalize Order if CAPTURED (Phase 08A) ───────────────────────────
    if (this.orderService && targetStatus === PaymentStatus.CAPTURED) {
      try {
        await this.orderService.finalizeFromPayment(attempt.id);
      } catch (orderError) {
        // Operational alert: order finalization failed after payment capture.
        // We log the error but still return PROCESSED so the webhook provider
        // does not retry endlessly if the issue requires operational intervention.
        this.logger.error(
          `[CRITICAL] Order finalization failed for CAPTURED payment attempt ${attempt.id}: ${(orderError as Error).message}`,
          (orderError as Error).stack,
        );
      }
    }

    // ── 10. Mark event as processed ─────────────────────────────────────────
    await this.markProcessed(webhookEventId);

    this.logger.log(
      `Webhook event ${eventId} processed: payment ${attempt.id} transitioned ${currentStatus} → ${targetStatus}`,
    );

    return 'PROCESSED';
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private async markProcessed(webhookEventId: string): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { processedAt: new Date() },
    });
  }

  /**
   * Validates that provider-reported amount and currency match local authoritative values.
   *
   * Returns 'OK' when integrity is confirmed.
   * Returns 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH' | 'MISSING_FIELDS' when rejected.
   *
   * On failure: logs an audit event and does NOT apply the state transition.
   */
  private async validateAmountAndCurrency(
    event: ParsedRazorpayWebhookEvent,
    attempt: { id: string; amount: number; currency: string },
    webhookEventId: string,
    provider: string,
    eventId: string,
  ): Promise<'OK' | 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH' | 'MISSING_FIELDS'> {
    // Missing amount or currency from provider is not assumed valid
    if (event.amountPaise === null || event.amountPaise === undefined) {
      this.logger.error(
        `Webhook event ${eventId} (${event.eventType}): provider amount is missing — rejecting financial transition for payment ${attempt.id}`,
      );
      await this.auditService.logEvent({
        actorId: 'SYSTEM',
        actorRole: 'SYSTEM',
        actorEmail: `webhook:${provider}:${eventId}`,
        action: AuditAction.PAYMENT_AMOUNT_INTEGRITY_VIOLATION,
        entityType: AuditEntityType.PAYMENT,
        entityId: attempt.id,
        metadata: {
          webhookEventId,
          eventId,
          provider,
          reason: 'PROVIDER_AMOUNT_MISSING',
          localAmount: attempt.amount,
          localCurrency: attempt.currency,
        },
      });
      return 'MISSING_FIELDS';
    }

    if (!event.currency) {
      this.logger.error(
        `Webhook event ${eventId} (${event.eventType}): provider currency is missing — rejecting financial transition for payment ${attempt.id}`,
      );
      await this.auditService.logEvent({
        actorId: 'SYSTEM',
        actorRole: 'SYSTEM',
        actorEmail: `webhook:${provider}:${eventId}`,
        action: AuditAction.PAYMENT_AMOUNT_INTEGRITY_VIOLATION,
        entityType: AuditEntityType.PAYMENT,
        entityId: attempt.id,
        metadata: {
          webhookEventId,
          eventId,
          provider,
          reason: 'PROVIDER_CURRENCY_MISSING',
          localAmount: attempt.amount,
          localCurrency: attempt.currency,
        },
      });
      return 'MISSING_FIELDS';
    }

    if (event.amountPaise !== attempt.amount) {
      this.logger.error(
        `Webhook event ${eventId} (${event.eventType}): amount mismatch for payment ${attempt.id} — local: ${attempt.amount}, provider: ${event.amountPaise}`,
      );
      await this.auditService.logEvent({
        actorId: 'SYSTEM',
        actorRole: 'SYSTEM',
        actorEmail: `webhook:${provider}:${eventId}`,
        action: AuditAction.PAYMENT_AMOUNT_INTEGRITY_VIOLATION,
        entityType: AuditEntityType.PAYMENT,
        entityId: attempt.id,
        metadata: {
          webhookEventId,
          eventId,
          provider,
          reason: 'AMOUNT_MISMATCH',
          localAmount: attempt.amount,
          localCurrency: attempt.currency,
          // NOTE: We do NOT store the provider amount in a field that could overwrite local.
          // The local authoritative amount is NEVER modified by a webhook.
        },
      });
      return 'AMOUNT_MISMATCH';
    }

    if (event.currency !== attempt.currency) {
      this.logger.error(
        `Webhook event ${eventId} (${event.eventType}): currency mismatch for payment ${attempt.id} — local: ${attempt.currency}, provider: ${event.currency}`,
      );
      await this.auditService.logEvent({
        actorId: 'SYSTEM',
        actorRole: 'SYSTEM',
        actorEmail: `webhook:${provider}:${eventId}`,
        action: AuditAction.PAYMENT_AMOUNT_INTEGRITY_VIOLATION,
        entityType: AuditEntityType.PAYMENT,
        entityId: attempt.id,
        metadata: {
          webhookEventId,
          eventId,
          provider,
          reason: 'CURRENCY_MISMATCH',
          localCurrency: attempt.currency,
        },
      });
      return 'CURRENCY_MISMATCH';
    }

    return 'OK';
  }

  /**
   * Handles the REQUIRES_RECONCILIATION scenario:
   * Provider reports CAPTURED but local state is FAILED or CANCELLED.
   *
   * This is a financial discrepancy — money may have been captured while local
   * state recorded a failure. This must NEVER be silently discarded.
   *
   * Actions:
   * - Transitions local PaymentAttempt to REQUIRES_RECONCILIATION (explicit sentinel)
   * - Creates a PAYMENT_RECONCILIATION_REQUIRED audit event with full context
   * - Returns 'RECONCILIATION_REQUIRED' for operational visibility
   */
  private async handleReconciliation(
    attempt: { id: string; status: string; amount: number; currency: string; userId: string },
    webhookEventId: string,
    provider: string,
    eventId: string,
    event: ParsedRazorpayWebhookEvent,
    currentStatus: PaymentStatus,
  ): Promise<'RECONCILIATION_REQUIRED'> {
    this.logger.error(
      `PAYMENT RECONCILIATION REQUIRED: payment ${attempt.id} is ${currentStatus} locally but provider reports CAPTURED. Webhook event: ${eventId}`,
    );

    // Transition to REQUIRES_RECONCILIATION sentinel state
    // This uses a WHERE clause on current status for optimistic concurrency safety
    try {
      await this.prisma.paymentAttempt.updateMany({
        where: {
          id: attempt.id,
          status: currentStatus,
        },
        data: {
          status: PaymentStatus.REQUIRES_RECONCILIATION,
          providerPaymentId: event.razorpayPaymentId ?? undefined,
          failureCode: 'RECONCILIATION_REQUIRED',
          failureMessage:
            `Payment was ${currentStatus} locally when provider reported CAPTURED. ` +
            `Admin investigation required. Provider event: ${eventId}`,
        },
      });
    } catch (updateErr: unknown) {
      // Concurrent update won the race — still log audit, do not fail
      this.logger.warn(
        `Reconciliation update for payment ${attempt.id} skipped (concurrent update): ${(updateErr as Error).message}`,
      );
    }

    await this.auditService.logEvent({
      actorId: 'SYSTEM',
      actorRole: 'SYSTEM',
      actorEmail: `webhook:${provider}:${eventId}`,
      action: AuditAction.PAYMENT_RECONCILIATION_REQUIRED,
      entityType: AuditEntityType.PAYMENT,
      entityId: attempt.id,
      previousValue: JSON.stringify({ status: currentStatus }),
      newValue: JSON.stringify({ status: PaymentStatus.REQUIRES_RECONCILIATION }),
      metadata: {
        webhookEventId,
        eventId,
        provider,
        localStatusAtEvent: currentStatus,
        providerStatus: 'CAPTURED',
        providerPaymentId: event.razorpayPaymentId,
        providerOrderId: event.razorpayOrderId,
        amountPaise: attempt.amount,
        currency: attempt.currency,
        userId: attempt.userId,
        reason: 'PROVIDER_CAPTURED_WHILE_LOCAL_FAILED_OR_CANCELLED',
      },
    });

    await this.markProcessed(webhookEventId);
    return 'RECONCILIATION_REQUIRED';
  }
}
