/**
 * WebhookController — Razorpay Webhook Ingestion
 *
 * HTTP boundary for inbound Razorpay webhook events.
 *
 * CRITICAL SECURITY REQUIREMENTS:
 * 1. The raw request body MUST be captured BEFORE NestJS JSON deserialization.
 *    The route is registered with Express `express.raw()` middleware so the
 *    body arrives as a Buffer (not a parsed object).
 * 2. Signature verification MUST succeed before any payload processing.
 * 3. Always return HTTP 200 to Razorpay (even for duplicates or ignored events)
 *    to prevent unnecessary retries. Retries only for genuine 5xx failures.
 * 4. RAZORPAY_WEBHOOK_SECRET is read from environment only (never from request data).
 *
 * Raw body registration:
 * This controller is wired to skip NestJS's global JSON body parser for the
 * webhook path. See `main.ts` for the express.raw() middleware registration.
 */

import {
  Controller,
  Post,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { verifyRazorpayWebhookSignature } from './providers/razorpay/razorpay-signature.util.js';
import { WebhookService } from './webhook.service.js';
import type {
  RazorpayWebhookPayload,
  ParsedRazorpayWebhookEvent,
} from './providers/razorpay/razorpay-webhook.types.js';


/**
 * Parses the verified raw Razorpay payload into a domain-safe event object.
 * Never returns raw SDK objects.
 */
function parseRazorpayWebhookPayload(
  payload: RazorpayWebhookPayload,
): ParsedRazorpayWebhookEvent {
  const paymentEntity = payload.payload?.payment?.entity;

  return {
    eventType: payload.event,
    razorpayOrderId: paymentEntity?.order_id ?? payload.payload?.order?.entity?.id ?? null,
    razorpayPaymentId: paymentEntity?.id ?? null,
    failureCode: paymentEntity?.error_code ?? null,
    failureMessage: paymentEntity?.error_description ?? null,
    amountPaise: paymentEntity?.amount ?? null,
    currency: paymentEntity?.currency ?? null,
    createdAtUnix: payload.created_at,
  };
}

@Controller('webhooks')
@SkipThrottle()
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly webhookService: WebhookService) {}

  /**
   * POST /api/v1/webhooks/razorpay
   *
   * Receives Razorpay webhook events. No authentication required (public endpoint).
   * Security is enforced via HMAC-SHA256 signature verification.
   *
   * Always returns 200 on:
   * - Successfully processed events
   * - Duplicate events (idempotent)
   * - Ignored/unknown event types
   * - Reconciliation-required events (logged for operational visibility)
   *
   * Returns 400 on:
   * - Missing or invalid signature header
   * - Non-buffer body (middleware misconfiguration)
   *
   * Returns 500 on:
   * - Internal processing error (Razorpay will retry)
   */
  @Post('razorpay')
  @HttpCode(HttpStatus.OK)
  async handleRazorpayWebhook(
    @Req() req: Request,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') officialEventId: string | undefined,
  ): Promise<{ received: boolean; result: string }> {
    // ── 1. Validate raw body is a Buffer (middleware guard) ──────────────────
    if (!Buffer.isBuffer(req.body)) {
      this.logger.error(
        'Webhook body is not a Buffer — express.raw() middleware may not be registered correctly',
      );
      throw new BadRequestException(
        'Webhook body must be raw bytes. Middleware misconfiguration detected.',
      );
    }

    const rawBody: Buffer = req.body;

    // ── 2. Validate signature header presence ────────────────────────────────
    if (!signature) {
      this.logger.warn('Razorpay webhook received without signature header');
      throw new BadRequestException('Missing X-Razorpay-Signature header');
    }

    // ── 3. Read webhook secret ───────────────────────────────────────────────
    const webhookSecret = process.env['RAZORPAY_WEBHOOK_SECRET'];
    if (!webhookSecret) {
      this.logger.error(
        'RAZORPAY_WEBHOOK_SECRET not configured — cannot verify webhook signature',
      );
      // Return 500 so Razorpay retries — this is a configuration error
      throw new InternalServerErrorException(
        'Webhook secret not configured. Contact the system administrator.',
      );
    }

    // ── 4. Verify HMAC-SHA256 signature ─────────────────────────────────────
    const isValid = verifyRazorpayWebhookSignature(rawBody, signature, webhookSecret);
    if (!isValid) {
      this.logger.warn(
        'Razorpay webhook signature verification FAILED — possible spoofing attempt',
      );
      throw new BadRequestException('Webhook signature verification failed');
    }

    // ── 5. Parse the verified payload ────────────────────────────────────────
    let parsed: RazorpayWebhookPayload;
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as RazorpayWebhookPayload;
    } catch {
      this.logger.warn('Razorpay webhook body could not be parsed as JSON after signature verification');
      throw new BadRequestException('Invalid webhook payload format');
    }

    // ── 6. Resolve stable event ID for idempotency ───────────────────────────
    // PRIMARY:  X-Razorpay-Event-Id header (official, stable, unique per event).
    // FALLBACK: Construct deterministic ID from eventType + paymentId.
    //   - Using eventType prefix ensures two different events for the same payment
    //     never collapse to the same dedup key.
    //   - Last resort: accountId + eventType + createdAt for events without a paymentId.
    const razorpayPaymentId = parsed.payload?.payment?.entity?.id;
    const eventId =
      officialEventId ??
      (razorpayPaymentId
        ? `${parsed.event}_${razorpayPaymentId}`
        : `${parsed.event}_${parsed.account_id}_${parsed.created_at}`);

    // ── 7. Parse into domain-safe event ─────────────────────────────────────
    const domainEvent = parseRazorpayWebhookPayload(parsed);

    this.logger.log(
      `Razorpay webhook received: eventType=${domainEvent.eventType}, eventId=${eventId}, officialHeader=${officialEventId ?? 'absent'}`,
    );

    // ── 8. Delegate to webhook domain service ────────────────────────────────
    let result: 'PROCESSED' | 'DUPLICATE' | 'IGNORED' | 'RECONCILIATION_REQUIRED';
    try {
      result = await this.webhookService.processWebhookEvent(
        'RAZORPAY',
        eventId,
        domainEvent,
        // Store a sanitised copy (JSON-serialisable) for audit
        parsed as unknown as Record<string, unknown>,
      );
    } catch (err: unknown) {
      this.logger.error(
        `Razorpay webhook processing error for event ${eventId}: ${(err as Error).message}`,
      );
      // 500 instructs Razorpay to retry the event
      throw new InternalServerErrorException(
        'Webhook processing failed. Please retry.',
      );
    }

    return { received: true, result };
  }
}
