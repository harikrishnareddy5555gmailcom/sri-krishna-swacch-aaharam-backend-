/**
 * Phase 07B Remediation — Physical PostgreSQL Concurrency & Database Integration Tests
 *
 * Runs against the real PostgreSQL test database (DATABASE_URL_TEST).
 *
 * Verifies:
 * 1. WebhookEvent unique constraint on [provider, eventId] (P1 / P0-4)
 * 2. Distinct events for the same payment attempt remain distinct (P1)
 * 3. Concurrent webhook delivery (optimistic concurrency, CAPTURED never regresses) (P1)
 * 4. Expiration / Webhook race & reconciliation (P0-3)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PaymentStatus, AuditAction, AuditEntityType, UserRole } from '@vishkaraa/types';
import { PaymentService } from '../src/payment/payment.service.js';
import { WebhookService } from '../src/payment/webhook.service.js';
import { MockPaymentProvider } from '../src/payment/providers/mock-payment.provider.js';

describe('Payment & Webhook Concurrency — Physical PostgreSQL Integration', () => {
  const testDbUrl =
    process.env['DATABASE_URL_TEST'] ||
    process.env['DATABASE_URL'] ||
    'postgresql://postgres:password@localhost:5432/vishkaraa_test?schema=public';

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: testDbUrl,
      },
    },
  });

  let paymentService: PaymentService;
  let webhookService: WebhookService;
  let testUserId: string;
  let testCheckoutSessionId: string;
  const loggedAuditActions: AuditAction[] = [];

  beforeAll(async () => {
    await prisma.$connect();

    const mockAuditService = {
      logEvent: async (entry: { action: AuditAction }) => {
        loggedAuditActions.push(entry.action);
      },
    };

    const mockFeaturesService = {
      isFeatureEnabled: async () => true,
    };

    const mockCheckoutService = {
      assertCheckoutReadyForPayment: async () => {},
    };

    const mockOwnershipService = {
      isAuthorized: async () => true,
    };

    const mockProvider = new MockPaymentProvider();

    paymentService = new PaymentService(
      prisma as any,
      mockAuditService as any,
      mockFeaturesService as any,
      mockCheckoutService as any,
      mockOwnershipService as any,
      mockProvider,
    );

    webhookService = new WebhookService(
      prisma as any,
      mockAuditService as any,
      paymentService,
    );

    // Create unique test user and checkout session for test isolation
    const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const user = await prisma.user.create({
      data: {
        email: `concur-test-${uniqueSuffix}@vishkaraa.test`,
        passwordHash: 'dummy-hash',
        firstName: 'Test',
        lastName: 'Concurrency',
        role: 'USER',
      },
    });
    testUserId = user.id;

    // Create cart and checkout session
    const cart = await prisma.cart.create({
      data: {
        userId: testUserId,
        currency: 'INR',
      },
    });

    const session = await prisma.checkoutSession.create({
      data: {
        userId: testUserId,
        cartId: cart.id,
        status: 'ACTIVE',
        subtotal: 299900,
        currency: 'INR',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    testCheckoutSessionId = session.id;
  });

  afterAll(async () => {
    // Cleanup created test records
    try {
      await prisma.webhookEvent.deleteMany({
        where: { provider: 'RAZORPAY_TEST_INTEG' },
      });
      await prisma.paymentAttempt.deleteMany({
        where: { userId: testUserId },
      });
      await prisma.checkoutSession.deleteMany({
        where: { userId: testUserId },
      });
      await prisma.cart.deleteMany({
        where: { userId: testUserId },
      });
      await prisma.user.deleteMany({
        where: { id: testUserId },
      });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('1. WebhookEvent unique constraint on [provider, eventId] prevents duplicate rows', async () => {
    const eventId = `evt_unique_test_${Date.now()}`;
    const provider = 'RAZORPAY_TEST_INTEG';

    // First insert succeeds
    const first = await prisma.webhookEvent.create({
      data: {
        provider,
        eventId,
        eventType: 'payment.captured',
        rawPayload: { test: true },
      },
    });
    expect(first.id).toBeDefined();

    // Second insert with same provider and eventId MUST fail with P2002
    await expect(
      prisma.webhookEvent.create({
        data: {
          provider,
          eventId,
          eventType: 'payment.captured',
          rawPayload: { test: true, duplicate: true },
        },
      }),
    ).rejects.toThrow();

    // WebhookService deduplicates using this constraint
    const result = await webhookService.processWebhookEvent(
      provider,
      eventId,
      {
        eventType: 'payment.captured',
        razorpayOrderId: 'order_nonexistent',
        razorpayPaymentId: 'pay_nonexistent',
        failureCode: null,
        failureMessage: null,
        amountPaise: 299900,
        currency: 'INR',
        createdAtUnix: 123456,
      },
      { test: true },
    );

    expect(result).toBe('DUPLICATE');
  });

  it('2. Same payment attempt accepts multiple distinct events without collision', async () => {
    const provider = 'RAZORPAY_TEST_INTEG';
    const providerOrderId = `order_distinct_${Date.now()}`;

    // Create payment attempt in test DB
    const attempt = await prisma.paymentAttempt.create({
      data: {
        userId: testUserId,
        checkoutSessionId: testCheckoutSessionId,
        amount: 299900,
        currency: 'INR',
        status: PaymentStatus.PENDING,
        provider,
        providerOrderId,
      },
    });

    const event1Id = `evt_dist_1_${Date.now()}`;
    const event2Id = `evt_dist_2_${Date.now()}`;

    // Event 1: payment.authorized
    const res1 = await webhookService.processWebhookEvent(
      provider,
      event1Id,
      {
        eventType: 'payment.authorized',
        razorpayOrderId: providerOrderId,
        razorpayPaymentId: 'pay_dist_01',
        failureCode: null,
        failureMessage: null,
        amountPaise: 299900,
        currency: 'INR',
        createdAtUnix: 100,
      },
      {},
    );
    expect(res1).toBe('PROCESSED');

    // Event 2: payment.captured
    const res2 = await webhookService.processWebhookEvent(
      provider,
      event2Id,
      {
        eventType: 'payment.captured',
        razorpayOrderId: providerOrderId,
        razorpayPaymentId: 'pay_dist_01',
        failureCode: null,
        failureMessage: null,
        amountPaise: 299900,
        currency: 'INR',
        createdAtUnix: 101,
      },
      {},
    );
    expect(res2).toBe('PROCESSED');

    // Verify both events exist in webhook_events and link to the same paymentAttempt
    const events = await prisma.webhookEvent.findMany({
      where: { paymentAttemptId: attempt.id },
    });
    expect(events.length).toBe(2);
    expect(events.map((e) => e.eventId).sort()).toEqual([event1Id, event2Id].sort());

    // Final status is CAPTURED
    const finalAttempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(finalAttempt.status).toBe(PaymentStatus.CAPTURED);
  });

  it('3. Concurrent webhook delivery: CAPTURED never regresses to an earlier state', async () => {
    const provider = 'RAZORPAY_TEST_INTEG';
    const providerOrderId = `order_concur_${Date.now()}`;

    const attempt = await prisma.paymentAttempt.create({
      data: {
        userId: testUserId,
        checkoutSessionId: testCheckoutSessionId,
        amount: 299900,
        currency: 'INR',
        status: PaymentStatus.PENDING,
        provider,
        providerOrderId,
      },
    });

    // Simulate concurrent delivery of CAPTURED and delayed AUTHORIZED in parallel
    const capturePromise = webhookService.processWebhookEvent(
      provider,
      `evt_concur_cap_${Date.now()}`,
      {
        eventType: 'payment.captured',
        razorpayOrderId: providerOrderId,
        razorpayPaymentId: 'pay_concur_01',
        failureCode: null,
        failureMessage: null,
        amountPaise: 299900,
        currency: 'INR',
        createdAtUnix: 200,
      },
      {},
    );

    const authorizedPromise = webhookService.processWebhookEvent(
      provider,
      `evt_concur_auth_${Date.now()}`,
      {
        eventType: 'payment.authorized',
        razorpayOrderId: providerOrderId,
        razorpayPaymentId: 'pay_concur_01',
        failureCode: null,
        failureMessage: null,
        amountPaise: 299900,
        currency: 'INR',
        createdAtUnix: 199,
      },
      {},
    );

    const [r1, r2] = await Promise.all([capturePromise, authorizedPromise]);
    expect([r1, r2]).toContain('PROCESSED');

    // Physical DB verification: final state MUST be CAPTURED
    const physical = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(physical.status).toBe(PaymentStatus.CAPTURED);
  });

  it('4. Expiration / Webhook race: FAILED + provider CAPTURED transitions to REQUIRES_RECONCILIATION', async () => {
    const provider = 'RAZORPAY_TEST_INTEG';
    const providerOrderId = `order_expire_race_${Date.now()}`;

    // Attempt was expired and locally marked FAILED
    const attempt = await prisma.paymentAttempt.create({
      data: {
        userId: testUserId,
        checkoutSessionId: testCheckoutSessionId,
        amount: 299900,
        currency: 'INR',
        status: PaymentStatus.FAILED,
        failureCode: 'PAYMENT_EXPIRED',
        failureMessage: 'Expired by PaymentExpirationService',
        provider,
        providerOrderId,
      },
    });

    const eventId = `evt_race_cap_${Date.now()}`;
    // Delayed webhook arrives from provider indicating funds WERE captured
    const result = await webhookService.processWebhookEvent(
      provider,
      eventId,
      {
        eventType: 'payment.captured',
        razorpayOrderId: providerOrderId,
        razorpayPaymentId: 'pay_race_99',
        failureCode: null,
        failureMessage: null,
        amountPaise: 299900,
        currency: 'INR',
        createdAtUnix: 300,
      },
      {},
    );

    expect(result).toBe('RECONCILIATION_REQUIRED');

    // Physical DB verification: state MUST be REQUIRES_RECONCILIATION (not normal CAPTURED or FAILED)
    const physical = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(physical.status).toBe(PaymentStatus.REQUIRES_RECONCILIATION);
    expect(physical.failureCode).toBe('RECONCILIATION_REQUIRED');
    expect(loggedAuditActions).toContain(AuditAction.PAYMENT_RECONCILIATION_REQUIRED);
  });
});
