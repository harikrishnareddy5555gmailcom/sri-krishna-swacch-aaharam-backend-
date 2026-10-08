/**
 * Phase 07B — Razorpay Webhook Tests
 *
 * Covers:
 * 1. HMAC-SHA256 signature verification utility
 * 2. WebhookService — idempotency deduplication
 * 3. WebhookService — amount & currency integrity validation (P0-2)
 * 4. WebhookService — reconciliation on money captured after failure (P0-3)
 * 5. WebhookController — raw body Buffer validation, official X-Razorpay-Event-Id header (P1)
 * 6. PaymentService.transitionStatusSystem — optimistic concurrency & state validation (P1)
 * 7. PaymentStateMachine — comprehensive transition evaluation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentStatus, AuditAction, AuditEntityType } from '@vishkaraa/types';
import { verifyRazorpayWebhookSignature } from '../src/payment/providers/razorpay/razorpay-signature.util.js';
import { WebhookService } from '../src/payment/webhook.service.js';
import { WebhookController } from '../src/payment/webhook.controller.js';
import { PaymentService } from '../src/payment/payment.service.js';
import { MockPaymentProvider } from '../src/payment/providers/mock-payment.provider.js';
import {
  PaymentStateMachine,
  TransitionEvaluationResult,
} from '../src/payment/state/payment-state-machine.js';
import type { ParsedRazorpayWebhookEvent } from '../src/payment/providers/razorpay/razorpay-webhook.types.js';
import type { Request } from 'express';

// ─── Helpers ────────────────────────────────────────────────────────────────

function signPayload(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function makeParsedEvent(
  overrides: Partial<ParsedRazorpayWebhookEvent> = {},
): ParsedRazorpayWebhookEvent {
  return {
    eventType: 'payment.captured',
    razorpayOrderId: 'order_test_001',
    razorpayPaymentId: 'pay_test_001',
    failureCode: null,
    failureMessage: null,
    amountPaise: 249900,
    currency: 'INR',
    createdAtUnix: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// ─── 1. Signature Verification Utility ──────────────────────────────────────

describe('verifyRazorpayWebhookSignature', () => {
  const secret = 'test-webhook-secret-32-chars-long!!';

  it('returns true for a valid HMAC-SHA256 signature', () => {
    const body = JSON.stringify({ event: 'payment.captured' });
    const sig = signPayload(body, secret);
    expect(verifyRazorpayWebhookSignature(Buffer.from(body), sig, secret)).toBe(true);
  });

  it('returns false for a tampered body (different bytes)', () => {
    const body = JSON.stringify({ event: 'payment.captured' });
    const tamperedBody = JSON.stringify({ event: 'payment.captured', injected: true });
    const sig = signPayload(body, secret);
    expect(
      verifyRazorpayWebhookSignature(Buffer.from(tamperedBody), sig, secret),
    ).toBe(false);
  });

  it('returns false for a wrong secret', () => {
    const body = JSON.stringify({ event: 'payment.captured' });
    const sig = signPayload(body, secret);
    expect(
      verifyRazorpayWebhookSignature(Buffer.from(body), sig, 'wrong-secret'),
    ).toBe(false);
  });

  it('returns false when signature is empty string', () => {
    const body = JSON.stringify({ event: 'payment.captured' });
    expect(verifyRazorpayWebhookSignature(Buffer.from(body), '', secret)).toBe(false);
  });

  it('returns true for a correctly signed empty buffer (edge case)', () => {
    const sig = signPayload('', secret);
    expect(verifyRazorpayWebhookSignature(Buffer.from(''), sig, secret)).toBe(true);
  });

  it('returns false for an empty buffer signed with the wrong secret', () => {
    const sig = signPayload('', 'wrong-secret');
    expect(verifyRazorpayWebhookSignature(Buffer.from(''), sig, secret)).toBe(false);
  });

  it('is resistant to length-extension: length-different sigs return false', () => {
    const body = JSON.stringify({ event: 'payment.captured' });
    const sig = signPayload(body, secret);
    expect(verifyRazorpayWebhookSignature(Buffer.from(body), sig.slice(0, 10), secret)).toBe(false);
  });

  it('uses the exact raw Buffer bytes (not re-serialised)', () => {
    const rawBytes = Buffer.from('{"event":"payment.captured","spacing":  "preserved"}', 'utf8');
    const sig = createHmac('sha256', secret).update(rawBytes).digest('hex');
    expect(verifyRazorpayWebhookSignature(rawBytes, sig, secret)).toBe(true);
  });
});

// ─── 2. WebhookService — Domain Processing ───────────────────────────────────

describe('WebhookService', () => {
  let webhookService: WebhookService;
  let mockPrisma: any;
  let mockAudit: any;
  let mockPaymentService: any;

  const providerId = 'RAZORPAY';
  const eventId = 'payment.captured_pay_test_001';

  beforeEach(() => {
    mockPrisma = {
      webhookEvent: {
        create: vi.fn(),
        update: vi.fn(),
      },
      paymentAttempt: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    mockAudit = {
      logEvent: vi.fn().mockResolvedValue(undefined),
    };

    mockPaymentService = {
      transitionStatusSystem: vi.fn().mockResolvedValue({
        id: 'attempt-001',
        status: PaymentStatus.CAPTURED,
      }),
    };

    webhookService = new WebhookService(
      mockPrisma as any,
      mockAudit as any,
      mockPaymentService as any,
    );
  });

  it('returns DUPLICATE when P2002 unique constraint fires (same event received twice)', async () => {
    const p2002 = Object.assign(new Error('unique violation'), { code: 'P2002' });
    mockPrisma.webhookEvent.create.mockRejectedValueOnce(p2002);

    const result = await webhookService.processWebhookEvent(
      providerId,
      eventId,
      makeParsedEvent(),
      {},
    );

    expect(result).toBe('DUPLICATE');
    expect(mockPaymentService.transitionStatusSystem).not.toHaveBeenCalled();
  });

  it('returns IGNORED when eventType is not a handled payment transition', async () => {
    mockPrisma.webhookEvent.create.mockResolvedValueOnce({ id: 'wh-001' });
    mockPrisma.webhookEvent.update.mockResolvedValueOnce({});

    const result = await webhookService.processWebhookEvent(
      providerId,
      'order.created_001',
      makeParsedEvent({ eventType: 'order.paid', razorpayOrderId: null }),
      {},
    );

    expect(result).toBe('IGNORED');
    expect(mockPaymentService.transitionStatusSystem).not.toHaveBeenCalled();
  });

  it('returns IGNORED when no matching PaymentAttempt found for providerOrderId', async () => {
    mockPrisma.webhookEvent.create.mockResolvedValueOnce({ id: 'wh-001' });
    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce(null);
    mockPrisma.webhookEvent.update.mockResolvedValueOnce({});

    const result = await webhookService.processWebhookEvent(
      providerId,
      eventId,
      makeParsedEvent({ eventType: 'payment.captured', razorpayOrderId: 'unknown_order' }),
      {},
    );

    expect(result).toBe('IGNORED');
  });

  it('calls transitionStatusSystem and returns PROCESSED for valid payment.captured event', async () => {
    mockPrisma.webhookEvent.create.mockResolvedValueOnce({ id: 'wh-001' });
    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
      id: 'attempt-001',
      status: PaymentStatus.PENDING,
      amount: 249900,
      currency: 'INR',
      providerOrderId: 'order_test_001',
    });
    mockPrisma.webhookEvent.update.mockResolvedValue({});

    const result = await webhookService.processWebhookEvent(
      providerId,
      eventId,
      makeParsedEvent({ eventType: 'payment.captured' }),
      {},
    );

    expect(result).toBe('PROCESSED');
    expect(mockPaymentService.transitionStatusSystem).toHaveBeenCalledWith(
      'attempt-001',
      PaymentStatus.CAPTURED,
      `webhook:RAZORPAY:${eventId}`,
      {
        providerPaymentId: 'pay_test_001',
        failureCode: undefined,
        failureMessage: undefined,
      },
    );
  });

  it('returns PROCESSED (no-op) for stale payment.authorized arriving after CAPTURED', async () => {
    mockPrisma.webhookEvent.create.mockResolvedValueOnce({ id: 'wh-002' });
    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
      id: 'attempt-001',
      status: PaymentStatus.CAPTURED,
      amount: 249900,
      currency: 'INR',
      providerOrderId: 'order_test_001',
    });
    mockPrisma.webhookEvent.update.mockResolvedValue({});

    const result = await webhookService.processWebhookEvent(
      providerId,
      'payment.authorized_stale',
      makeParsedEvent({ eventType: 'payment.authorized' }),
      {},
    );

    expect(result).toBe('PROCESSED');
    expect(mockPaymentService.transitionStatusSystem).not.toHaveBeenCalled();
  });

  it('returns PROCESSED and logs PAYMENT_SECURITY_VIOLATION for INVALID_TRANSITION (CREATED → CAPTURED)', async () => {
    mockPrisma.webhookEvent.create.mockResolvedValueOnce({ id: 'wh-003' });
    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
      id: 'attempt-001',
      status: PaymentStatus.CREATED,
      amount: 249900,
      currency: 'INR',
      providerOrderId: 'order_test_001',
    });
    mockPrisma.webhookEvent.update.mockResolvedValue({});

    const result = await webhookService.processWebhookEvent(
      providerId,
      'payment.captured_after_created',
      makeParsedEvent({ eventType: 'payment.captured' }),
      {},
    );

    expect(result).toBe('PROCESSED');
    expect(mockAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.PAYMENT_SECURITY_VIOLATION,
        entityType: AuditEntityType.PAYMENT,
      }),
    );
    expect(mockPaymentService.transitionStatusSystem).not.toHaveBeenCalled();
  });

  // ─── P0-2: Amount & Currency Integrity Tests ──────────────────────────────

  describe('P0-2: Amount and Currency Integrity', () => {
    it('exact amount and currency succeeds and applies CAPTURED', async () => {
      mockPrisma.webhookEvent.create.mockResolvedValueOnce({ id: 'wh-amt-01' });
      mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
        id: 'attempt-001',
        status: PaymentStatus.PENDING,
        amount: 50000,
        currency: 'INR',
        providerOrderId: 'order_test_001',
      });
      mockPrisma.webhookEvent.update.mockResolvedValue({});

      const result = await webhookService.processWebhookEvent(
        providerId,
        'evt_amt_match',
        makeParsedEvent({ amountPaise: 50000, currency: 'INR' }),
        {},
      );

      expect(result).toBe('PROCESSED');
      expect(mockPaymentService.transitionStatusSystem).toHaveBeenCalled();
    });

    it('rejects amount mismatch: does NOT transition, logs PAYMENT_AMOUNT_INTEGRITY_VIOLATION audit', async () => {
      mockPrisma.webhookEvent.create.mockResolvedValueOnce({ id: 'wh-amt-02' });
      mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
        id: 'attempt-001',
        status: PaymentStatus.PENDING,
        amount: 249900,
        currency: 'INR',
        providerOrderId: 'order_test_001',
      });
      mockPrisma.webhookEvent.update.mockResolvedValue({});

      const result = await webhookService.processWebhookEvent(
        providerId,
        'evt_amt_mismatch',
        makeParsedEvent({ amountPaise: 10000, currency: 'INR' }), // Attempted underpayment/spoof
        {},
      );

      expect(result).toBe('PROCESSED');
      expect(mockPaymentService.transitionStatusSystem).not.toHaveBeenCalled();
      expect(mockAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYMENT_AMOUNT_INTEGRITY_VIOLATION,
          entityType: AuditEntityType.PAYMENT,
          metadata: expect.objectContaining({
            reason: 'AMOUNT_MISMATCH',
            localAmount: 249900,
          }),
        }),
      );
    });

    it('rejects currency mismatch: does NOT transition, logs PAYMENT_AMOUNT_INTEGRITY_VIOLATION audit', async () => {
      mockPrisma.webhookEvent.create.mockResolvedValueOnce({ id: 'wh-curr-01' });
      mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
        id: 'attempt-001',
        status: PaymentStatus.PENDING,
        amount: 249900,
        currency: 'INR',
        providerOrderId: 'order_test_001',
      });
      mockPrisma.webhookEvent.update.mockResolvedValue({});

      const result = await webhookService.processWebhookEvent(
        providerId,
        'evt_curr_mismatch',
        makeParsedEvent({ amountPaise: 249900, currency: 'USD' }),
        {},
      );

      expect(result).toBe('PROCESSED');
      expect(mockPaymentService.transitionStatusSystem).not.toHaveBeenCalled();
      expect(mockAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYMENT_AMOUNT_INTEGRITY_VIOLATION,
          metadata: expect.objectContaining({
            reason: 'CURRENCY_MISMATCH',
          }),
        }),
      );
    });

    it('handles missing provider amount safely without applying financial state', async () => {
      mockPrisma.webhookEvent.create.mockResolvedValueOnce({ id: 'wh-missing-amt' });
      mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
        id: 'attempt-001',
        status: PaymentStatus.PENDING,
        amount: 249900,
        currency: 'INR',
        providerOrderId: 'order_test_001',
      });
      mockPrisma.webhookEvent.update.mockResolvedValue({});

      const result = await webhookService.processWebhookEvent(
        providerId,
        'evt_missing_amt',
        makeParsedEvent({ amountPaise: null, currency: 'INR' }),
        {},
      );

      expect(result).toBe('PROCESSED');
      expect(mockPaymentService.transitionStatusSystem).not.toHaveBeenCalled();
      expect(mockAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYMENT_AMOUNT_INTEGRITY_VIOLATION,
          metadata: expect.objectContaining({
            reason: 'PROVIDER_AMOUNT_MISSING',
          }),
        }),
      );
    });

    it('handles missing provider currency safely without applying financial state', async () => {
      mockPrisma.webhookEvent.create.mockResolvedValueOnce({ id: 'wh-missing-curr' });
      mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
        id: 'attempt-001',
        status: PaymentStatus.PENDING,
        amount: 249900,
        currency: 'INR',
        providerOrderId: 'order_test_001',
      });
      mockPrisma.webhookEvent.update.mockResolvedValue({});

      const result = await webhookService.processWebhookEvent(
        providerId,
        'evt_missing_curr',
        makeParsedEvent({ amountPaise: 249900, currency: null }),
        {},
      );

      expect(result).toBe('PROCESSED');
      expect(mockPaymentService.transitionStatusSystem).not.toHaveBeenCalled();
      expect(mockAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYMENT_AMOUNT_INTEGRITY_VIOLATION,
          metadata: expect.objectContaining({
            reason: 'PROVIDER_CURRENCY_MISSING',
          }),
        }),
      );
    });
  });

  // ─── P0-3: Reconciliation (Money Captured After Failure) ───────────────────

  describe('P0-3: Reconciliation (Money Captured After Local Failure)', () => {
    it('FAILED + provider CAPTURED transitions to REQUIRES_RECONCILIATION and logs audit', async () => {
      mockPrisma.webhookEvent.create.mockResolvedValueOnce({ id: 'wh-rec-01' });
      mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
        id: 'attempt-001',
        status: PaymentStatus.FAILED,
        amount: 249900,
        currency: 'INR',
        userId: 'user-001',
        providerOrderId: 'order_test_001',
      });
      mockPrisma.webhookEvent.update.mockResolvedValue({});

      const result = await webhookService.processWebhookEvent(
        providerId,
        'evt_captured_after_failed',
        makeParsedEvent({ eventType: 'payment.captured' }),
        {},
      );

      expect(result).toBe('RECONCILIATION_REQUIRED');
      // PaymentService transitionStatusSystem is NOT called (bypass normal transition)
      expect(mockPaymentService.transitionStatusSystem).not.toHaveBeenCalled();
      // Record updated to REQUIRES_RECONCILIATION sentinel
      expect(mockPrisma.paymentAttempt.updateMany).toHaveBeenCalledWith({
        where: { id: 'attempt-001', status: PaymentStatus.FAILED },
        data: expect.objectContaining({
          status: PaymentStatus.REQUIRES_RECONCILIATION,
          failureCode: 'RECONCILIATION_REQUIRED',
        }),
      });
      // Audit event logged
      expect(mockAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYMENT_RECONCILIATION_REQUIRED,
          entityType: AuditEntityType.PAYMENT,
          entityId: 'attempt-001',
          newValue: JSON.stringify({ status: PaymentStatus.REQUIRES_RECONCILIATION }),
        }),
      );
    });

    it('CANCELLED + provider CAPTURED transitions to REQUIRES_RECONCILIATION', async () => {
      mockPrisma.webhookEvent.create.mockResolvedValueOnce({ id: 'wh-rec-02' });
      mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
        id: 'attempt-002',
        status: PaymentStatus.CANCELLED,
        amount: 249900,
        currency: 'INR',
        userId: 'user-002',
        providerOrderId: 'order_test_001',
      });
      mockPrisma.webhookEvent.update.mockResolvedValue({});

      const result = await webhookService.processWebhookEvent(
        providerId,
        'evt_captured_after_cancelled',
        makeParsedEvent({ eventType: 'payment.captured' }),
        {},
      );

      expect(result).toBe('RECONCILIATION_REQUIRED');
      expect(mockPrisma.paymentAttempt.updateMany).toHaveBeenCalledWith({
        where: { id: 'attempt-002', status: PaymentStatus.CANCELLED },
        data: expect.objectContaining({
          status: PaymentStatus.REQUIRES_RECONCILIATION,
        }),
      });
    });

    it('duplicate CAPTURED event after reconciliation remains safe idempotent no-op', async () => {
      mockPrisma.webhookEvent.create.mockResolvedValueOnce({ id: 'wh-rec-03' });
      mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
        id: 'attempt-003',
        status: PaymentStatus.REQUIRES_RECONCILIATION,
        amount: 249900,
        currency: 'INR',
        providerOrderId: 'order_test_001',
      });
      mockPrisma.webhookEvent.update.mockResolvedValue({});

      const result = await webhookService.processWebhookEvent(
        providerId,
        'evt_captured_dup_reconciliation',
        makeParsedEvent({ eventType: 'payment.captured' }),
        {},
      );

      expect(result).toBe('PROCESSED');
      expect(mockPaymentService.transitionStatusSystem).not.toHaveBeenCalled();
      expect(mockPrisma.paymentAttempt.updateMany).not.toHaveBeenCalled();
    });
  });
});

// ─── 3. WebhookController — HTTP Boundary ───────────────────────────────────

describe('WebhookController', () => {
  const webhookSecret = 'test-webhook-secret-for-controller!!';
  let webhookController: WebhookController;
  let mockWebhookService: any;

  beforeEach(() => {
    process.env['RAZORPAY_WEBHOOK_SECRET'] = webhookSecret;

    mockWebhookService = {
      processWebhookEvent: vi.fn().mockResolvedValue('PROCESSED'),
    };

    webhookController = new WebhookController(mockWebhookService as any);
  });

  afterEach(() => {
    delete process.env['RAZORPAY_WEBHOOK_SECRET'];
  });

  function makeRawRequest(body: Buffer): Partial<Request> {
    return { body };
  }

  it('throws BadRequestException when body is not a Buffer', async () => {
    const req = { body: '{"event":"payment.captured"}' } as any;
    await expect(
      webhookController.handleRazorpayWebhook(req, 'some-sig', undefined),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when X-Razorpay-Signature header is missing', async () => {
    const body = Buffer.from('{}');
    const req = makeRawRequest(body) as any;
    await expect(
      webhookController.handleRazorpayWebhook(req, undefined, undefined),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when signature is invalid (wrong secret)', async () => {
    const bodyStr = JSON.stringify({
      event: 'payment.captured',
      account_id: 'acc_001',
      created_at: 1000,
      contains: [],
      payload: {},
    });
    const body = Buffer.from(bodyStr);
    const wrongSig = signPayload(bodyStr, 'wrong-secret');
    const req = makeRawRequest(body) as any;

    await expect(
      webhookController.handleRazorpayWebhook(req, wrongSig, undefined),
    ).rejects.toThrow(BadRequestException);
  });

  it('uses official X-Razorpay-Event-Id header when present (P1)', async () => {
    const payload = {
      entity: 'event',
      account_id: 'acc_001',
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: 'pay_test_001',
            order_id: 'order_test_001',
            status: 'captured',
            amount: 249900,
            currency: 'INR',
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };
    const bodyStr = JSON.stringify(payload);
    const body = Buffer.from(bodyStr);
    const sig = signPayload(bodyStr, webhookSecret);
    const req = makeRawRequest(body) as any;

    const result = await webhookController.handleRazorpayWebhook(
      req,
      sig,
      'evt_official_razorpay_id_9999',
    );

    expect(result.received).toBe(true);
    expect(mockWebhookService.processWebhookEvent).toHaveBeenCalledWith(
      'RAZORPAY',
      'evt_official_razorpay_id_9999',
      expect.anything(),
      expect.anything(),
    );
  });

  it('falls back to deterministic event ID when X-Razorpay-Event-Id header is absent', async () => {
    const payload = {
      entity: 'event',
      account_id: 'acc_001',
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: 'pay_test_001',
            order_id: 'order_test_001',
            status: 'captured',
            amount: 249900,
            currency: 'INR',
          },
        },
      },
      created_at: 1234567,
    };
    const bodyStr = JSON.stringify(payload);
    const body = Buffer.from(bodyStr);
    const sig = signPayload(bodyStr, webhookSecret);
    const req = makeRawRequest(body) as any;

    await webhookController.handleRazorpayWebhook(req, sig, undefined);

    expect(mockWebhookService.processWebhookEvent).toHaveBeenCalledWith(
      'RAZORPAY',
      'payment.captured_pay_test_001',
      expect.anything(),
      expect.anything(),
    );
  });

  it('returns HTTP 200 with result RECONCILIATION_REQUIRED when service reports it', async () => {
    mockWebhookService.processWebhookEvent.mockResolvedValueOnce('RECONCILIATION_REQUIRED');

    const payload = {
      entity: 'event',
      account_id: 'acc_001',
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: 'pay_test_001',
            order_id: 'order_test_001',
            status: 'captured',
            amount: 249900,
            currency: 'INR',
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };
    const bodyStr = JSON.stringify(payload);
    const body = Buffer.from(bodyStr);
    const sig = signPayload(bodyStr, webhookSecret);
    const req = makeRawRequest(body) as any;

    const result = await webhookController.handleRazorpayWebhook(req, sig, 'evt_rec_001');

    expect(result.received).toBe(true);
    expect(result.result).toBe('RECONCILIATION_REQUIRED');
  });
});

// ─── 4. PaymentService.transitionStatusSystem ────────────────────────────────

describe('PaymentService.transitionStatusSystem (Optimistic Concurrency & Security)', () => {
  let paymentService: PaymentService;
  let mockPrisma: any;
  let mockAudit: any;
  let mockFeatures: any;
  let mockCheckout: any;
  let mockOwnership: any;
  let mockProvider: MockPaymentProvider;

  beforeEach(() => {
    mockPrisma = {
      paymentAttempt: {
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockAudit = { logEvent: vi.fn().mockResolvedValue(undefined) };
    mockFeatures = { isFeatureEnabled: vi.fn().mockResolvedValue(true) };
    mockCheckout = { assertCheckoutReadyForPayment: vi.fn() };
    mockOwnership = { isAuthorized: vi.fn() };
    mockProvider = new MockPaymentProvider();

    paymentService = new PaymentService(
      mockPrisma as any,
      mockAudit as any,
      mockFeatures as any,
      mockCheckout as any,
      mockOwnership as any,
      mockProvider,
    );
  });

  it('throws NotFoundException for unknown attempt', async () => {
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce(null);
    await expect(
      paymentService.transitionStatusSystem(
        'nonexistent-id',
        PaymentStatus.CAPTURED,
        'webhook:RAZORPAY:evt_001',
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('applies PENDING → CAPTURED transition with optimistic concurrency check', async () => {
    const attempt = {
      id: 'attempt-001',
      userId: 'user-001',
      checkoutSessionId: 'sess-001',
      amount: 249900,
      currency: 'INR',
      status: PaymentStatus.PENDING,
      provider: 'RAZORPAY',
      providerOrderId: 'order_test_001',
      providerPaymentId: null,
      idempotencyKey: null,
      failureCode: null,
      failureMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const updated = { ...attempt, status: PaymentStatus.CAPTURED, providerPaymentId: 'pay_001' };
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce(attempt);
    mockPrisma.paymentAttempt.findUniqueOrThrow.mockResolvedValueOnce(updated);

    const result = await paymentService.transitionStatusSystem(
      'attempt-001',
      PaymentStatus.CAPTURED,
      'webhook:RAZORPAY:pay.captured_pay_001',
      { providerPaymentId: 'pay_001' },
    );

    expect(result.status).toBe(PaymentStatus.CAPTURED);
    expect(mockPrisma.paymentAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: 'attempt-001', status: PaymentStatus.PENDING },
      data: expect.objectContaining({
        status: PaymentStatus.CAPTURED,
        providerPaymentId: 'pay_001',
      }),
    });
    expect(mockAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'SYSTEM',
        action: AuditAction.PAYMENT_STATE_CHANGED,
        entityType: AuditEntityType.PAYMENT,
        entityId: 'attempt-001',
      }),
    );
  });

  it('handles concurrent race gracefully when updateMany matches 0 rows (stale update)', async () => {
    const attemptAtRead = {
      id: 'attempt-001',
      status: PaymentStatus.PENDING,
      amount: 249900,
      currency: 'INR',
      provider: 'RAZORPAY',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const latestAfterRace = {
      ...attemptAtRead,
      status: PaymentStatus.CAPTURED, // already captured by winner
    };

    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce(attemptAtRead);
    // Concurrent update won: 0 rows updated by this caller
    mockPrisma.paymentAttempt.updateMany.mockResolvedValueOnce({ count: 0 });
    mockPrisma.paymentAttempt.findUniqueOrThrow.mockResolvedValueOnce(latestAfterRace);

    const result = await paymentService.transitionStatusSystem(
      'attempt-001',
      PaymentStatus.AUTHORIZED,
      'webhook:RAZORPAY:delayed_authorized',
    );

    // Stale update returns current winner's state without overwriting
    expect(result.status).toBe(PaymentStatus.CAPTURED);
    // Audit event was NOT logged for stale write
    expect(mockAudit.logEvent).not.toHaveBeenCalled();
  });

  it('throws for invalid transition CREATED → CAPTURED', async () => {
    const attempt = {
      id: 'attempt-001',
      status: PaymentStatus.CREATED,
      provider: 'RAZORPAY',
    };
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce(attempt);

    await expect(
      paymentService.transitionStatusSystem(
        'attempt-001',
        PaymentStatus.CAPTURED,
        'webhook:RAZORPAY:invalid',
      ),
    ).rejects.toThrow(/Invalid payment status transition/);
  });

  it('throws reconciliation required error when attempting direct FAILED → CAPTURED', async () => {
    const attempt = {
      id: 'attempt-001',
      status: PaymentStatus.FAILED,
      provider: 'RAZORPAY',
    };
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce(attempt);

    await expect(
      paymentService.transitionStatusSystem(
        'attempt-001',
        PaymentStatus.CAPTURED,
        'webhook:RAZORPAY:captured_after_failed',
      ),
    ).rejects.toThrow(/Reconciliation required/);
  });
});

// ─── 5. PaymentStateMachine Coverage ─────────────────────────────────────────

describe('PaymentStateMachine — State Transitions & Invariants', () => {
  it('evaluates progressive transitions as APPLIED', () => {
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CREATED, PaymentStatus.PENDING)).toBe(
      TransitionEvaluationResult.APPLIED,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.PENDING, PaymentStatus.AUTHORIZED)).toBe(
      TransitionEvaluationResult.APPLIED,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.AUTHORIZED, PaymentStatus.CAPTURED)).toBe(
      TransitionEvaluationResult.APPLIED,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.PENDING, PaymentStatus.CAPTURED)).toBe(
      TransitionEvaluationResult.APPLIED,
    );
  });

  it('evaluates duplicate transitions as NO_OP_DUPLICATE', () => {
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CAPTURED, PaymentStatus.CAPTURED)).toBe(
      TransitionEvaluationResult.NO_OP_DUPLICATE,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.PENDING, PaymentStatus.PENDING)).toBe(
      TransitionEvaluationResult.NO_OP_DUPLICATE,
    );
  });

  it('evaluates stale out-of-order events arriving after CAPTURED as NO_OP_STALE_EVENT', () => {
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CAPTURED, PaymentStatus.AUTHORIZED)).toBe(
      TransitionEvaluationResult.NO_OP_STALE_EVENT,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CAPTURED, PaymentStatus.PENDING)).toBe(
      TransitionEvaluationResult.NO_OP_STALE_EVENT,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CAPTURED, PaymentStatus.FAILED)).toBe(
      TransitionEvaluationResult.NO_OP_STALE_EVENT,
    );
  });

  it('evaluates FAILED or CANCELLED + CAPTURED as REQUIRES_RECONCILIATION', () => {
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.FAILED, PaymentStatus.CAPTURED)).toBe(
      TransitionEvaluationResult.REQUIRES_RECONCILIATION,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CANCELLED, PaymentStatus.CAPTURED)).toBe(
      TransitionEvaluationResult.REQUIRES_RECONCILIATION,
    );
  });

  it('evaluates CREATED → CAPTURED as INVALID_TRANSITION', () => {
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CREATED, PaymentStatus.CAPTURED)).toBe(
      TransitionEvaluationResult.INVALID_TRANSITION,
    );
  });
});
