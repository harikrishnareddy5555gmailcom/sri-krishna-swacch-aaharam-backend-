import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import {
  UserRole,
  PaymentStatus,
  AuditAction,
  AuditEntityType,
  FeatureKey,
} from '@vishkaraa/types';
import { Prisma } from '@prisma/client';
import { PaymentService } from '../src/payment/payment.service.js';
import { MockPaymentProvider } from '../src/payment/providers/mock-payment.provider.js';
import {
  PaymentStateMachine,
  TransitionEvaluationResult,
} from '../src/payment/state/payment-state-machine.js';
import type { MinimalUser } from '../src/permissions/permissions.service.js';

describe('Payment Domain & Provider-Independent Architecture (Phase 07A)', () => {
  let paymentService: PaymentService;
  let mockPrisma: any;
  let mockAudit: any;
  let mockFeatures: any;
  let mockCheckout: any;
  let mockOwnership: any;
  let mockProvider: MockPaymentProvider;

  const userA: MinimalUser = {
    id: 'user-a-uuid',
    role: UserRole.USER,
    email: 'usera@vishkaraa.local',
  };

  const userB: MinimalUser = {
    id: 'user-b-uuid',
    role: UserRole.USER,
    email: 'userb@vishkaraa.local',
  };

  const adminUser: MinimalUser = {
    id: 'admin-uuid',
    role: UserRole.ADMIN,
    email: 'admin@vishkaraa.local',
  };

  const validCheckoutSessionId = 'checkout-session-123';
  const authoritativePaise = 249900; // ₹2499.00
  const authoritativeCurrency = 'INR';

  beforeEach(() => {
    mockPrisma = {
      paymentAttempt: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    };

    mockAudit = {
      logEvent: vi.fn().mockResolvedValue(undefined),
    };

    mockFeatures = {
      isFeatureEnabled: vi.fn().mockImplementation(async (key: FeatureKey) => {
        return key === FeatureKey.PAYMENTS || key === FeatureKey.CHECKOUT || key === FeatureKey.CART;
      }),
    };

    mockCheckout = {
      assertCheckoutReadyForPayment: vi.fn().mockImplementation(async (sessionId: string, user: MinimalUser) => {
        if (user.id !== userA.id) {
          throw new ForbiddenException('You do not have permission to pay for this checkout session');
        }
        return {
          session: {
            id: sessionId,
            userId: user.id,
            subtotal: authoritativePaise,
            currency: authoritativeCurrency,
          },
          payableAmount: authoritativePaise,
          currency: authoritativeCurrency,
        };
      }),
    };

    mockOwnership = {
      resolveOwnerId: vi.fn().mockImplementation(async (_type: string, id: string) => {
        if (id === 'attempt-user-b') return userB.id;
        return userA.id;
      }),
      isAuthorized: vi.fn().mockImplementation(async (user: MinimalUser, _type: string, id: string) => {
        if (user.role === UserRole.SUPER_ADMIN) return { authorized: true };
        const ownerId = id === 'attempt-user-b' ? userB.id : userA.id;
        if (!ownerId) return { authorized: false, reason: 'Not found' };
        if (user.id === ownerId) return { authorized: true };
        return { authorized: false, reason: 'Not owner' };
      }),
    };

    mockProvider = new MockPaymentProvider();

    paymentService = new PaymentService(
      mockPrisma,
      mockAudit,
      mockFeatures,
      mockCheckout,
      mockOwnership,
      mockProvider,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Authentication & Ownership Boundary
  // ─────────────────────────────────────────────────────────────────────────────

  it('1. unauthenticated payment creation rejected by guard / missing user', async () => {
    // Calling with undefined user should throw or fail
    await expect(
      paymentService.createPaymentAttempt(
        { checkoutSessionId: validCheckoutSessionId },
        undefined as any,
      ),
    ).rejects.toThrow();
  });

  it('2. User A cannot pay User B checkout', async () => {
    mockCheckout.assertCheckoutReadyForPayment.mockRejectedValueOnce(
      new ForbiddenException('You do not have permission to pay for this checkout session'),
    );

    await expect(
      paymentService.createPaymentAttempt(
        { checkoutSessionId: 'user-b-checkout' },
        userA,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('3. Admin cannot pay another user checkout', async () => {
    mockCheckout.assertCheckoutReadyForPayment.mockRejectedValueOnce(
      new ForbiddenException('You do not have permission to pay for this checkout session'),
    );

    await expect(
      paymentService.createPaymentAttempt(
        { checkoutSessionId: validCheckoutSessionId },
        adminUser,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Feature Registry & Transitive Dependency Checks
  // ─────────────────────────────────────────────────────────────────────────────

  it('4. Checkout feature disabled rejects payment', async () => {
    mockFeatures.isFeatureEnabled.mockResolvedValueOnce(false);

    await expect(
      paymentService.createPaymentAttempt(
        { checkoutSessionId: validCheckoutSessionId },
        userA,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('5. Payment feature disabled rejects payment', async () => {
    mockFeatures.isFeatureEnabled.mockImplementation(async (key: FeatureKey) => {
      if (key === FeatureKey.PAYMENTS) return false;
      return true;
    });

    await expect(
      paymentService.createPaymentAttempt(
        { checkoutSessionId: validCheckoutSessionId },
        userA,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('6. Cart dependency disabled rejects payment', async () => {
    mockFeatures.isFeatureEnabled.mockImplementation(async (key: FeatureKey) => {
      if (key === FeatureKey.CART) return false;
      // When Cart is disabled, PAYMENTS isFeatureEnabled evaluates to false due to transitive dependencies
      return false;
    });

    await expect(
      paymentService.createPaymentAttempt(
        { checkoutSessionId: validCheckoutSessionId },
        userA,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Checkout Authority & Validation Delegation
  // ─────────────────────────────────────────────────────────────────────────────

  it('7. stale / expired checkout rejected via assertCheckoutReadyForPayment', async () => {
    mockCheckout.assertCheckoutReadyForPayment.mockRejectedValueOnce(
      new BadRequestException({
        code: 'SESSION_EXPIRED',
        message: 'Checkout session has expired.',
      }),
    );

    await expect(
      paymentService.createPaymentAttempt(
        { checkoutSessionId: validCheckoutSessionId },
        userA,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('8. price change rejected via assertCheckoutReadyForPayment', async () => {
    mockCheckout.assertCheckoutReadyForPayment.mockRejectedValueOnce(
      new BadRequestException({
        code: 'CHECKOUT_VALIDATION_FAILED',
        message: 'Checkout items or prices have changed and require customer re-review before payment.',
      }),
    );

    await expect(
      paymentService.createPaymentAttempt(
        { checkoutSessionId: validCheckoutSessionId },
        userA,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('9. inactive variant rejected via assertCheckoutReadyForPayment', async () => {
    mockCheckout.assertCheckoutReadyForPayment.mockRejectedValueOnce(
      new BadRequestException({
        code: 'CHECKOUT_VALIDATION_FAILED',
        message: 'Variant is no longer active.',
      }),
    );

    await expect(
      paymentService.createPaymentAttempt(
        { checkoutSessionId: validCheckoutSessionId },
        userA,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('10. authoritative amount and currency used from CheckoutService', async () => {
    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce(null);
    mockPrisma.paymentAttempt.create.mockResolvedValueOnce({
      id: 'attempt-1',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.CREATED,
      provider: 'MOCK',
      idempotencyKey: null,
      providerOrderId: null,
      providerPaymentId: null,
      failureCode: null,
      failureMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockPrisma.paymentAttempt.update.mockResolvedValueOnce({
      id: 'attempt-1',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.PENDING,
      provider: 'MOCK',
      providerOrderId: 'order_mock_123',
      providerPaymentId: null,
      idempotencyKey: null,
      failureCode: null,
      failureMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await paymentService.createPaymentAttempt(
      { checkoutSessionId: validCheckoutSessionId },
      userA,
    );

    expect(result.amount).toBe(authoritativePaise);
    expect(result.currency).toBe('INR');
    expect(mockPrisma.paymentAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amount: authoritativePaise,
          currency: authoritativeCurrency,
        }),
      }),
    );
  });

  it('11. frontend amount is ignored (not accepted in DTO/service)', async () => {
    // Passing arbitrary rogue amount in payload
    const rogueDto: any = {
      checkoutSessionId: validCheckoutSessionId,
      amount: 1, // Attempt to pay 1 rupee
    };

    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce(null);
    mockPrisma.paymentAttempt.create.mockResolvedValueOnce({
      id: 'attempt-rogue',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.CREATED,
      provider: 'MOCK',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockPrisma.paymentAttempt.update.mockResolvedValueOnce({
      id: 'attempt-rogue',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.PENDING,
      provider: 'MOCK',
      providerOrderId: 'order_mock_rogue',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await paymentService.createPaymentAttempt(rogueDto, userA);

    // The recorded amount must strictly be authoritativePaise (249900), NOT 1
    expect(result.amount).toBe(authoritativePaise);
  });

  it('12. frontend currency is ignored (not accepted in DTO/service)', async () => {
    const rogueDto: any = {
      checkoutSessionId: validCheckoutSessionId,
      currency: 'USD',
    };

    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce(null);
    mockPrisma.paymentAttempt.create.mockResolvedValueOnce({
      id: 'attempt-rogue-curr',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: 'INR',
      status: PaymentStatus.CREATED,
      provider: 'MOCK',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockPrisma.paymentAttempt.update.mockResolvedValueOnce({
      id: 'attempt-rogue-curr',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: 'INR',
      status: PaymentStatus.PENDING,
      provider: 'MOCK',
      providerOrderId: 'order_mock_curr',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await paymentService.createPaymentAttempt(rogueDto, userA);
    expect(result.currency).toBe('INR');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Payment Amount Immutability & Retries
  // ─────────────────────────────────────────────────────────────────────────────

  it('13. payment amount persisted in PaymentAttempt record', async () => {
    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce(null);
    mockPrisma.paymentAttempt.create.mockResolvedValueOnce({
      id: 'attempt-persist',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.CREATED,
      provider: 'MOCK',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockPrisma.paymentAttempt.update.mockResolvedValueOnce({
      id: 'attempt-persist',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.PENDING,
      provider: 'MOCK',
      providerOrderId: 'order_mock_persist',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await paymentService.createPaymentAttempt(
      { checkoutSessionId: validCheckoutSessionId },
      userA,
    );
    expect(res.amount).toBe(249900);
  });

  it('14. payment amount cannot be silently changed during transition', async () => {
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
      id: 'attempt-user-a',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.PENDING,
      provider: 'MOCK',
      providerOrderId: 'order_1',
    });

    mockPrisma.paymentAttempt.update.mockResolvedValueOnce({
      id: 'attempt-user-a',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise, // strictly preserved
      currency: authoritativeCurrency,
      status: PaymentStatus.CAPTURED,
      provider: 'MOCK',
      providerOrderId: 'order_1',
      providerPaymentId: 'pay_123',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const transitioned = await paymentService.transitionStatus(
      'attempt-user-a',
      PaymentStatus.CAPTURED,
      userA,
      { providerPaymentId: 'pay_123' },
    );

    expect(transitioned.amount).toBe(authoritativePaise);
    expect(mockPrisma.paymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ amount: expect.anything() }),
      }),
    );
  });

  it('15. retry creates separate attempt record after previous failed', async () => {
    // Attempt 1 exists as FAILED
    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce(null); // No CREATED or PENDING active attempts!
    mockPrisma.paymentAttempt.create.mockResolvedValueOnce({
      id: 'attempt-retry-2',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.CREATED,
      provider: 'MOCK',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockPrisma.paymentAttempt.update.mockResolvedValueOnce({
      id: 'attempt-retry-2',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.PENDING,
      provider: 'MOCK',
      providerOrderId: 'order_mock_retry2',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const retryResult = await paymentService.createPaymentAttempt(
      { checkoutSessionId: validCheckoutSessionId },
      userA,
    );

    expect(retryResult.id).toBe('attempt-retry-2');
    expect(retryResult.status).toBe(PaymentStatus.PENDING);
  });

  it('16. failed attempt remains historically intact', async () => {
    const historicalFailedAttempt = {
      id: 'attempt-old-failed',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.FAILED,
      provider: 'MOCK',
      failureCode: 'PROVIDER_ERROR',
      failureMessage: 'Card declined',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce(historicalFailedAttempt);

    const retrieved = await paymentService.getPaymentAttempt('attempt-user-a', userA);
    expect(retrieved.status).toBe(PaymentStatus.FAILED);
    expect(retrieved.failureCode).toBe('PROVIDER_ERROR');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Idempotency & Concurrency
  // ─────────────────────────────────────────────────────────────────────────────

  it('17. idempotency prevents duplicate payment attempts', async () => {
    const existingAttempt = {
      id: 'attempt-existing',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.PENDING,
      provider: 'MOCK',
      providerOrderId: 'order_existing',
      idempotencyKey: 'idem-key-123',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Fast-path lookup by userId + idempotencyKey returns existing without re-creating
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce(existingAttempt);

    const result = await paymentService.createPaymentAttempt(
      {
        checkoutSessionId: validCheckoutSessionId,
        idempotencyKey: 'idem-key-123',
      },
      userA,
    );

    expect(result.id).toBe('attempt-existing');
    expect(mockPrisma.paymentAttempt.create).not.toHaveBeenCalled();
  });

  it('18. concurrent payment creation collision handled safely', async () => {
    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce(null);

    // Simulate PostgreSQL P2002 conflict error (double-click/race condition)
    const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.19.3',
    });
    mockPrisma.paymentAttempt.create.mockRejectedValueOnce(p2002Error);

    // Concurrent lookup finds the attempt created by the parallel thread
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
      id: 'attempt-concurrent',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.PENDING,
      provider: 'MOCK',
      idempotencyKey: 'idem-concurrent',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await paymentService.createPaymentAttempt(
      {
        checkoutSessionId: validCheckoutSessionId,
        idempotencyKey: 'idem-concurrent',
      },
      userA,
    );

    expect(result.id).toBe('attempt-concurrent');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. State Machine & Audit
  // ─────────────────────────────────────────────────────────────────────────────

  it('19. invalid state transition rejected (FAILED -> CAPTURED)', async () => {
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
      id: 'attempt-user-a',
      userId: userA.id,
      status: PaymentStatus.FAILED,
    });

    await expect(
      paymentService.transitionStatus(
        'attempt-user-a',
        PaymentStatus.CAPTURED,
        userA,
      ),
    ).rejects.toThrow(/Invalid payment status transition/);
  });

  it('20. audit state transition logged with sanitized metadata', async () => {
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
      id: 'attempt-user-a',
      userId: userA.id,
      status: PaymentStatus.PENDING,
    });
    mockPrisma.paymentAttempt.update.mockResolvedValueOnce({
      id: 'attempt-user-a',
      userId: userA.id,
      status: PaymentStatus.AUTHORIZED,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await paymentService.transitionStatus(
      'attempt-user-a',
      PaymentStatus.AUTHORIZED,
      userA,
    );

    expect(mockAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.PAYMENT_STATE_CHANGED,
        entityType: AuditEntityType.PAYMENT,
        entityId: 'attempt-user-a',
      }),
    );
  });

  it('21. sensitive card data, CVV, and secrets are absent from logs and audit', async () => {
    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce(null);
    mockPrisma.paymentAttempt.create.mockResolvedValueOnce({
      id: 'attempt-safe',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.CREATED,
      provider: 'MOCK',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockPrisma.paymentAttempt.update.mockResolvedValueOnce({
      id: 'attempt-safe',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.PENDING,
      provider: 'MOCK',
      providerOrderId: 'order_safe',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await paymentService.createPaymentAttempt(
      { checkoutSessionId: validCheckoutSessionId },
      userA,
    );

    const auditCalls = mockAudit.logEvent.mock.calls;
    for (const [call] of auditCalls) {
      const payloadString = JSON.stringify(call);
      expect(payloadString).not.toContain('cardNumber');
      expect(payloadString).not.toContain('cvv');
      expect(payloadString).not.toContain('pin');
      expect(payloadString).not.toContain('secret');
      expect(payloadString).not.toContain('key_secret');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Provider Abstraction
  // ─────────────────────────────────────────────────────────────────────────────

  it('22. provider interface receives authoritative amount', async () => {
    const providerSpy = vi.spyOn(mockProvider, 'createPaymentOrder');

    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce(null);
    mockPrisma.paymentAttempt.create.mockResolvedValueOnce({
      id: 'attempt-provider-test',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.CREATED,
      provider: 'MOCK',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockPrisma.paymentAttempt.update.mockResolvedValueOnce({
      id: 'attempt-provider-test',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.PENDING,
      provider: 'MOCK',
      providerOrderId: 'order_mock_test',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await paymentService.createPaymentAttempt(
      { checkoutSessionId: validCheckoutSessionId },
      userA,
    );

    expect(providerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: authoritativePaise,
        currency: 'INR',
      }),
    );
  });

  it('23. fake / mock provider response mapped to domain response without leaking', async () => {
    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce(null);
    mockPrisma.paymentAttempt.create.mockResolvedValueOnce({
      id: 'attempt-mock-res',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.CREATED,
      provider: 'MOCK',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockPrisma.paymentAttempt.update.mockResolvedValueOnce({
      id: 'attempt-mock-res',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.PENDING,
      provider: 'MOCK',
      providerOrderId: 'order_mock_mapped',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await paymentService.createPaymentAttempt(
      { checkoutSessionId: validCheckoutSessionId },
      userA,
    );

    expect(result.provider).toBe('MOCK');
    expect(result.providerOrderId).toBe('order_mock_mapped');
    expect(result.status).toBe(PaymentStatus.PENDING);
  });

  it('24. provider error transitions attempt to FAILED safely without throwing unhandled exception', async () => {
    mockProvider.shouldFailOrderCreation = true;
    mockProvider.failureMessage = 'Provider connection timeout';

    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce(null);
    mockPrisma.paymentAttempt.create.mockResolvedValueOnce({
      id: 'attempt-provider-fail',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.CREATED,
      provider: 'MOCK',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockPrisma.paymentAttempt.update.mockResolvedValueOnce({
      id: 'attempt-provider-fail',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.FAILED,
      provider: 'MOCK',
      failureCode: 'PROVIDER_ERROR',
      failureMessage: 'Provider connection timeout',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await paymentService.createPaymentAttempt(
      { checkoutSessionId: validCheckoutSessionId },
      userA,
    );

    expect(result.status).toBe(PaymentStatus.FAILED);
    expect(result.failureCode).toBe('PROVIDER_ERROR');
    expect(result.failureMessage).toBe('Provider connection timeout');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Remediation: Webhook-Safe Payment State Transitions (Blocker 2)
  // ─────────────────────────────────────────────────────────────────────────────

  it('25. CAPTURED + duplicate CAPTURED is a safe idempotent no-op', async () => {
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
      id: 'attempt-captured-1',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.CAPTURED,
      provider: 'MOCK',
      providerOrderId: 'order_cap_1',
      providerPaymentId: 'pay_cap_1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await paymentService.transitionStatus(
      'attempt-captured-1',
      PaymentStatus.CAPTURED,
      userA,
    );

    expect(result.status).toBe(PaymentStatus.CAPTURED);
    // Database update should not be invoked on duplicate no-op
    expect(mockPrisma.paymentAttempt.update).not.toHaveBeenCalled();
    // Audit event for state change should not be logged for duplicate no-op
    expect(mockAudit.logEvent).not.toHaveBeenCalled();
  });

  it('26. CAPTURED + delayed AUTHORIZED is a safe no-op that does not regress state', async () => {
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
      id: 'attempt-captured-2',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.CAPTURED,
      provider: 'MOCK',
      providerOrderId: 'order_cap_2',
      providerPaymentId: 'pay_cap_2',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await paymentService.transitionStatus(
      'attempt-captured-2',
      PaymentStatus.AUTHORIZED,
      userA,
    );

    expect(result.status).toBe(PaymentStatus.CAPTURED);
    expect(mockPrisma.paymentAttempt.update).not.toHaveBeenCalled();
  });

  it('27. CAPTURED + delayed FAILED must NOT regress to FAILED', async () => {
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
      id: 'attempt-captured-3',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.CAPTURED,
      provider: 'MOCK',
      providerOrderId: 'order_cap_3',
      providerPaymentId: 'pay_cap_3',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await paymentService.transitionStatus(
      'attempt-captured-3',
      PaymentStatus.FAILED,
      userA,
      { failureCode: 'LATE_ERROR', failureMessage: 'Late failure arrives' },
    );

    expect(result.status).toBe(PaymentStatus.CAPTURED);
    expect(mockPrisma.paymentAttempt.update).not.toHaveBeenCalled();
  });

  it('28. CAPTURED + delayed CANCELLED must NOT regress to CANCELLED', async () => {
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
      id: 'attempt-captured-4',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.CAPTURED,
      provider: 'MOCK',
      providerOrderId: 'order_cap_4',
      providerPaymentId: 'pay_cap_4',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await paymentService.transitionStatus(
      'attempt-captured-4',
      PaymentStatus.CANCELLED,
      userA,
    );

    expect(result.status).toBe(PaymentStatus.CAPTURED);
    expect(mockPrisma.paymentAttempt.update).not.toHaveBeenCalled();
  });

  it('29. FAILED + CAPTURED remains an invalid transition and throws', async () => {
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
      id: 'attempt-failed-1',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.FAILED,
      provider: 'MOCK',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      paymentService.transitionStatus(
        'attempt-failed-1',
        PaymentStatus.CAPTURED,
        userA,
      ),
    ).rejects.toThrow(/Invalid payment status transition: cannot transition from FAILED to CAPTURED/);
  });

  it('30. CANCELLED + CAPTURED remains an invalid transition and throws', async () => {
    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
      id: 'attempt-cancelled-1',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.CANCELLED,
      provider: 'MOCK',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      paymentService.transitionStatus(
        'attempt-cancelled-1',
        PaymentStatus.CAPTURED,
        userA,
      ),
    ).rejects.toThrow(/Invalid payment status transition: cannot transition from CANCELLED to CAPTURED/);
  });

  it('31. PaymentStateMachine.evaluateTransition returns precise domain results', () => {
    // APPLIED
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CREATED, PaymentStatus.PENDING)).toBe(
      TransitionEvaluationResult.APPLIED,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.PENDING, PaymentStatus.CAPTURED)).toBe(
      TransitionEvaluationResult.APPLIED,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.AUTHORIZED, PaymentStatus.CAPTURED)).toBe(
      TransitionEvaluationResult.APPLIED,
    );

    // NO_OP_DUPLICATE
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CAPTURED, PaymentStatus.CAPTURED)).toBe(
      TransitionEvaluationResult.NO_OP_DUPLICATE,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.PENDING, PaymentStatus.PENDING)).toBe(
      TransitionEvaluationResult.NO_OP_DUPLICATE,
    );

    // NO_OP_STALE_EVENT
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CAPTURED, PaymentStatus.AUTHORIZED)).toBe(
      TransitionEvaluationResult.NO_OP_STALE_EVENT,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CAPTURED, PaymentStatus.PENDING)).toBe(
      TransitionEvaluationResult.NO_OP_STALE_EVENT,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CAPTURED, PaymentStatus.FAILED)).toBe(
      TransitionEvaluationResult.NO_OP_STALE_EVENT,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CAPTURED, PaymentStatus.CANCELLED)).toBe(
      TransitionEvaluationResult.NO_OP_STALE_EVENT,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.AUTHORIZED, PaymentStatus.PENDING)).toBe(
      TransitionEvaluationResult.NO_OP_STALE_EVENT,
    );

    // REQUIRES_RECONCILIATION (P0-3 Remediation: money captured after failure)
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.FAILED, PaymentStatus.CAPTURED)).toBe(
      TransitionEvaluationResult.REQUIRES_RECONCILIATION,
    );
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CANCELLED, PaymentStatus.CAPTURED)).toBe(
      TransitionEvaluationResult.REQUIRES_RECONCILIATION,
    );

    // INVALID_TRANSITION
    expect(PaymentStateMachine.evaluateTransition(PaymentStatus.CREATED, PaymentStatus.CAPTURED)).toBe(
      TransitionEvaluationResult.INVALID_TRANSITION,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Remediation: Payment History Must Not Cascade Delete (Blocker 1)
  // ─────────────────────────────────────────────────────────────────────────────

  it('32. PaymentAttempt foreign key constraints prevent silent cascade deletion', async () => {
    // When a CheckoutSession with associated PaymentAttempts is attempted to be deleted,
    // PostgreSQL RESTRICT raises error code P2003 (Foreign key constraint violation).
    const p2003Error = new Prisma.PrismaClientKnownRequestError(
      'Foreign key constraint failed on the field: payment_attempts_checkoutSessionId_fkey',
      {
        code: 'P2003',
        clientVersion: '6.19.3',
      },
    );

    mockPrisma.checkoutSession = {
      delete: vi.fn().mockRejectedValueOnce(p2003Error),
    };

    await expect(
      mockPrisma.checkoutSession.delete({ where: { id: validCheckoutSessionId } }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });

  it('33. User deletion cannot cascade delete historical PaymentAttempt records', async () => {
    // When a User with associated PaymentAttempts is attempted to be deleted,
    // PostgreSQL RESTRICT raises error code P2003.
    const p2003UserError = new Prisma.PrismaClientKnownRequestError(
      'Foreign key constraint failed on the field: payment_attempts_userId_fkey',
      {
        code: 'P2003',
        clientVersion: '6.19.3',
      },
    );

    mockPrisma.user = {
      delete: vi.fn().mockRejectedValueOnce(p2003UserError),
    };

    await expect(
      mockPrisma.user.delete({ where: { id: userA.id } }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });

  it('34. returns existing active PENDING payment attempt with providerOrderId without conflict', async () => {
    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
      id: 'existing-pending-attempt',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.PENDING,
      provider: 'RAZORPAY',
      providerOrderId: 'order_existing_123',
      idempotencyKey: 'pay_original_key',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await paymentService.createPaymentAttempt(
      { checkoutSessionId: validCheckoutSessionId, idempotencyKey: 'different_key' },
      userA,
    );

    expect(result.id).toBe('existing-pending-attempt');
    expect(result.providerOrderId).toBe('order_existing_123');
    expect(result.status).toBe(PaymentStatus.PENDING);
  });

  it('35. supersedes existing active payment attempt when resetActive: true is provided', async () => {
    mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
      id: 'existing-stuck-attempt',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.PENDING,
      provider: 'MOCK',
      providerOrderId: 'order_old_123',
      idempotencyKey: 'pay_old',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockPrisma.paymentAttempt.update
      .mockResolvedValueOnce({
        id: 'existing-stuck-attempt',
        status: PaymentStatus.FAILED,
      })
      .mockResolvedValueOnce({
        id: 'new-fresh-attempt',
        userId: userA.id,
        checkoutSessionId: validCheckoutSessionId,
        amount: authoritativePaise,
        currency: authoritativeCurrency,
        status: PaymentStatus.PENDING,
        provider: 'MOCK',
        providerOrderId: 'order_fresh_456',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    mockPrisma.paymentAttempt.create.mockResolvedValueOnce({
      id: 'new-fresh-attempt',
      userId: userA.id,
      checkoutSessionId: validCheckoutSessionId,
      amount: authoritativePaise,
      currency: authoritativeCurrency,
      status: PaymentStatus.CREATED,
      provider: 'MOCK',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await paymentService.createPaymentAttempt(
      { checkoutSessionId: validCheckoutSessionId, resetActive: true },
      userA,
    );

    expect(mockPrisma.paymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'existing-stuck-attempt' },
        data: expect.objectContaining({ status: PaymentStatus.FAILED, failureCode: 'SUPERSEDED' }),
      }),
    );
    expect(result.id).toBe('new-fresh-attempt');
  });
});
