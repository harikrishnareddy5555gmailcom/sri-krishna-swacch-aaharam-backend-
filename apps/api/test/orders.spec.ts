import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma, PaymentStatus, CheckoutStatus, OrderStatus } from '@prisma/client';
import { AuditAction, AuditEntityType, UserRole } from '@vishkaraa/types';
import { OrderService } from '../src/orders/orders.service.js';
import { OrdersController } from '../src/orders/orders.controller.js';
import { OrderFinalizationError } from '../src/orders/order-finalization.error.js';
import { WebhookService } from '../src/payment/webhook.service.js';
import type { MinimalUser } from '../src/permissions/permissions.service.js';

describe('Order Domain — Phase 08A Order Finalization', () => {
  let orderService: OrderService;
  let mockPrisma: any;

  const testUser: MinimalUser = {
    id: 'user-uuid-1',
    role: UserRole.USER,
    email: 'user1@vishkaraa.local',
  };

  const otherUser: MinimalUser = {
    id: 'user-uuid-2',
    role: UserRole.USER,
    email: 'user2@vishkaraa.local',
  };

  const mockSnapshotItem = {
    id: 'snap-1',
    checkoutSessionId: 'sess-1',
    productId: 'prod-1',
    productVariantId: 'var-1',
    productName: 'Cold Pressed Sesame Oil',
    variantName: '500ml',
    productSku: 'SESAME-500ML',
    primaryImageUrl: 'https://images.vishkaraa.com/sesame.jpg',
    quantity: 2,
    unitPrice: 35000,
    lineTotal: 70000,
    currency: 'INR',
    createdAt: new Date('2026-09-29T10:00:00Z'),
  };

  const mockSession = {
    id: 'sess-1',
    userId: 'user-uuid-1',
    cartId: 'cart-uuid-1',
    status: CheckoutStatus.ACTIVE,
    currency: 'INR',
    subtotal: 70000,
    shippingName: 'Hari Raman',
    shippingPhone: '+919876543210',
    shippingLine1: '123 Natural Way',
    shippingLine2: 'Suite 4',
    shippingCity: 'Chennai',
    shippingState: 'Tamil Nadu',
    shippingPostalCode: '600001',
    shippingCountry: 'IN',
    items: [mockSnapshotItem],
    createdAt: new Date('2026-09-29T10:00:00Z'),
    updatedAt: new Date('2026-09-29T10:00:00Z'),
  };

  const mockAttempt = {
    id: 'attempt-1',
    userId: 'user-uuid-1',
    checkoutSessionId: 'sess-1',
    amount: 70000,
    currency: 'INR',
    status: PaymentStatus.CAPTURED,
    provider: 'RAZORPAY',
    providerOrderId: 'order_rzp_123',
    providerPaymentId: 'pay_rzp_456',
    checkoutSession: mockSession,
    createdAt: new Date('2026-09-29T10:05:00Z'),
    updatedAt: new Date('2026-09-29T10:06:00Z'),
  };

  const mockCreatedOrder = {
    id: 'order-uuid-1',
    orderNumber: 'VN-202609-A1B2C3D4',
    userId: 'user-uuid-1',
    checkoutSessionId: 'sess-1',
    paymentAttemptId: 'attempt-1',
    status: OrderStatus.CONFIRMED,
    subtotal: 70000,
    tax: 0,
    discount: 0,
    totalAmount: 70000,
    currency: 'INR',
    shippingName: 'Hari Raman',
    shippingPhone: '+919876543210',
    shippingLine1: '123 Natural Way',
    shippingLine2: 'Suite 4',
    shippingCity: 'Chennai',
    shippingState: 'Tamil Nadu',
    shippingPostalCode: '600001',
    shippingCountry: 'IN',
    confirmedAt: new Date('2026-09-29T10:06:00Z'),
    cancelledAt: null,
    notes: null,
    createdAt: new Date('2026-09-29T10:06:00Z'),
    updatedAt: new Date('2026-09-29T10:06:00Z'),
    items: [
      {
        id: 'oi-1',
        orderId: 'order-uuid-1',
        productId: 'prod-1',
        variantId: 'var-1',
        productName: 'Cold Pressed Sesame Oil',
        variantName: '500ml',
        productSku: 'SESAME-500ML',
        primaryImageUrl: 'https://images.vishkaraa.com/sesame.jpg',
        quantity: 2,
        unitPrice: 35000,
        lineTotal: 70000,
        currency: 'INR',
        createdAt: new Date('2026-09-29T10:06:00Z'),
      },
    ],
    paymentAttempt: mockAttempt,
  };

  beforeEach(() => {
    mockPrisma = {
      order: {
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn().mockResolvedValue(mockCreatedOrder),
        findMany: vi.fn().mockResolvedValue([mockCreatedOrder]),
        count: vi.fn().mockResolvedValue(1),
        create: vi.fn().mockResolvedValue(mockCreatedOrder),
      },
      orderItem: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      checkoutSession: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      cartItem: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({ id: 'ci-1' }),
        delete: vi.fn().mockResolvedValue({ id: 'ci-1' }),
      },
      paymentAttempt: {
        findUnique: vi.fn().mockResolvedValue(mockAttempt),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      },
      $transaction: vi.fn().mockImplementation(async (arg) => {
        if (typeof arg === 'function') {
          return arg({
            order: mockPrisma.order,
            orderItem: mockPrisma.orderItem,
            checkoutSession: mockPrisma.checkoutSession,
            cartItem: mockPrisma.cartItem,
            auditLog: mockPrisma.auditLog,
          });
        }
        if (Array.isArray(arg)) {
          return Promise.all(arg);
        }
        return arg;
      }),
    };

    orderService = new OrderService(mockPrisma);
  });

  describe('finalizeFromPayment', () => {
    it('creates a CONFIRMED order from a CAPTURED payment attempt', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);

      const result = await orderService.finalizeFromPayment('attempt-1');

      expect(result).toBeDefined();
      expect(result.status).toBe(OrderStatus.CONFIRMED);
      expect(result.totalAmount).toBe(70000);
      expect(result.subtotal).toBe(70000);
      expect(result.orderNumber).toMatch(/^VN-\d{6}-[A-F0-9]{8}$/);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].productName).toBe('Cold Pressed Sesame Oil');
      expect(result.items[0].variantName).toBe('500ml');
      expect(result.shipping.name).toBe('Hari Raman');
      expect(result.shipping.city).toBe('Chennai');

      // Verify transaction operations
      expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
      expect(mockPrisma.order.create).toHaveBeenCalledOnce();
      expect(mockPrisma.orderItem.createMany).toHaveBeenCalledOnce();
      expect(mockPrisma.checkoutSession.updateMany).toHaveBeenCalledWith({
        where: { id: 'sess-1', status: CheckoutStatus.ACTIVE },
        data: { status: CheckoutStatus.COMPLETED },
      });
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AuditAction.ORDER_FINALIZED,
            entityType: AuditEntityType.ORDER,
            actorRole: 'SYSTEM',
          }),
        }),
      );
    });

    it('returns existing order immediately when idempotency hit occurs (fast path)', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockCreatedOrder);

      const result = await orderService.finalizeFromPayment('attempt-1');

      expect(result.id).toBe(mockCreatedOrder.id);
      expect(mockPrisma.paymentAttempt.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects with ATTEMPT_NOT_FOUND when payment attempt does not exist', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      mockPrisma.paymentAttempt.findUnique.mockResolvedValue(null);

      const err = await orderService.finalizeFromPayment('non-existent').catch((e) => e);
      expect(err).toBeInstanceOf(OrderFinalizationError);
      expect(err.code).toBe('ATTEMPT_NOT_FOUND');
    });

    it('rejects with ATTEMPT_NOT_CAPTURED when attempt is PENDING', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      mockPrisma.paymentAttempt.findUnique.mockResolvedValue({
        ...mockAttempt,
        status: PaymentStatus.PENDING,
      });

      const err = await orderService.finalizeFromPayment('attempt-1').catch((e) => e);
      expect(err).toBeInstanceOf(OrderFinalizationError);
      expect(err.code).toBe('ATTEMPT_NOT_CAPTURED');
    });

    it('rejects with ATTEMPT_NOT_CAPTURED when attempt is FAILED', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(null);
      mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
        ...mockAttempt,
        status: PaymentStatus.FAILED,
      });

      await expect(orderService.finalizeFromPayment('attempt-1')).rejects.toMatchObject({
        code: 'ATTEMPT_NOT_CAPTURED',
      });
    });

    it('rejects with ATTEMPT_NOT_CAPTURED when attempt is REQUIRES_RECONCILIATION', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(null);
      mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
        ...mockAttempt,
        status: PaymentStatus.REQUIRES_RECONCILIATION,
      });

      await expect(orderService.finalizeFromPayment('attempt-1')).rejects.toMatchObject({
        code: 'ATTEMPT_NOT_CAPTURED',
      });
    });

    it('rejects with EMPTY_SNAPSHOT when session has no items', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(null);
      mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
        ...mockAttempt,
        checkoutSession: { ...mockSession, items: [] },
      });

      await expect(orderService.finalizeFromPayment('attempt-1')).rejects.toMatchObject({
        code: 'EMPTY_SNAPSHOT',
      });
    });

    it('rejects with AMOUNT_MISMATCH when payment amount differs from computed items total', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(null);
      mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
        ...mockAttempt,
        amount: 50000, // differs from 70000
      });

      await expect(orderService.finalizeFromPayment('attempt-1')).rejects.toMatchObject({
        code: 'AMOUNT_MISMATCH',
      });
    });

    it('rejects with CURRENCY_MISMATCH when payment currency differs from session currency', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(null);
      mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
        ...mockAttempt,
        currency: 'USD',
      });

      await expect(orderService.finalizeFromPayment('attempt-1')).rejects.toMatchObject({
        code: 'CURRENCY_MISMATCH',
      });
    });

    it('rejects with LINEITEM_INTEGRITY when item lineTotal does not match quantity * unitPrice', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(null);
      mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
        ...mockAttempt,
        amount: 80000,
        checkoutSession: {
          ...mockSession,
          items: [
            {
              ...mockSnapshotItem,
              quantity: 2,
              unitPrice: 35000,
              lineTotal: 80000, // Invalid: 2 * 35000 = 70000 != 80000
            },
          ],
        },
      });

      await expect(orderService.finalizeFromPayment('attempt-1')).rejects.toMatchObject({
        code: 'LINEITEM_INTEGRITY',
      });
    });

    it('handles concurrency race on paymentAttemptId idempotently (P2002)', async () => {
      mockPrisma.order.findUnique
        .mockResolvedValueOnce(null) // Step 1: no order initially
        .mockResolvedValueOnce(mockCreatedOrder); // Step 7 race handler: returns concurrent winner

      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint violation',
        {
          code: 'P2002',
          clientVersion: '5.x',
          meta: { target: ['payment_attempt_id'] },
        },
      );

      mockPrisma.$transaction.mockRejectedValueOnce(p2002Error);

      const result = await orderService.finalizeFromPayment('attempt-1');
      expect(result.id).toBe(mockCreatedOrder.id);
    });

    it('retries on orderNumber collision (P2002 on order_number)', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(null);

      const collisionError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint violation on order number',
        {
          code: 'P2002',
          clientVersion: '5.x',
          meta: { target: ['order_number'] },
        },
      );

      // First call fails with collision, second call succeeds
      mockPrisma.$transaction
        .mockRejectedValueOnce(collisionError)
        .mockResolvedValueOnce('order-uuid-1');

      const result = await orderService.finalizeFromPayment('attempt-1');
      expect(result.id).toBe(mockCreatedOrder.id);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('throws ORDER_NUMBER_EXHAUSTED if orderNumber collides repeatedly past MAX_ORDER_NUMBER_RETRIES', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(null);

      const collisionError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint violation on order number',
        {
          code: 'P2002',
          clientVersion: '5.x',
          meta: { target: ['order_number'] },
        },
      );

      mockPrisma.$transaction.mockRejectedValue(collisionError);

      await expect(orderService.finalizeFromPayment('attempt-1')).rejects.toMatchObject({
        code: 'ORDER_NUMBER_EXHAUSTED',
      });
    });
  });

  describe('Order Retrieval & Ownership Guarding', () => {
    it('getUserOrders returns paginated orders filtered by userId', async () => {
      const result = await orderService.getUserOrders(testUser.id, 1, 20);

      expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: testUser.id },
          skip: 0,
          take: 20,
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(result.orders).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('getOrderById returns order when user owns it', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(mockCreatedOrder);

      const result = await orderService.getOrderById(mockCreatedOrder.id, testUser.id);
      expect(result.id).toBe(mockCreatedOrder.id);
    });

    it('getOrderById throws ForbiddenException when accessed by a different user', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(mockCreatedOrder);

      await expect(
        orderService.getOrderById(mockCreatedOrder.id, otherUser.id),
      ).rejects.toThrow(ForbiddenException);
    });

    it('getOrderById throws NotFoundException when order does not exist', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(null);

      await expect(
        orderService.getOrderById('non-existent', testUser.id),
      ).rejects.toThrow(NotFoundException);
    });

    it('getOrderByNumber returns order when user owns it', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(mockCreatedOrder);

      const result = await orderService.getOrderByNumber(mockCreatedOrder.orderNumber, testUser.id);
      expect(result.orderNumber).toBe(mockCreatedOrder.orderNumber);
    });

    it('getOrderByNumber throws ForbiddenException when accessed by another user', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(mockCreatedOrder);

      await expect(
        orderService.getOrderByNumber(mockCreatedOrder.orderNumber, otherUser.id),
      ).rejects.toThrow(ForbiddenException);
    });

    it('getOrderByNumber throws NotFoundException when orderNumber does not exist', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(null);

      await expect(
        orderService.getOrderByNumber('VN-000000-NONEXIST', testUser.id),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('OrdersController', () => {
    let controller: OrdersController;

    beforeEach(() => {
      controller = new OrdersController(orderService);
    });

    it('getMyOrders delegates to OrderService with extracted user ID', async () => {
      const mockReq = { user: testUser } as any;
      const result = await controller.getMyOrders(mockReq, 1, 10);

      expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: testUser.id },
          skip: 0,
          take: 10,
        }),
      );
      expect(result.orders).toBeDefined();
    });

    it('getOrderById delegates to OrderService with orderId and user ID', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(mockCreatedOrder);
      const mockReq = { user: testUser } as any;

      const result = await controller.getOrderById(mockReq, mockCreatedOrder.id);
      expect(result.id).toBe(mockCreatedOrder.id);
    });

    it('getOrderByNumber delegates to OrderService with orderNumber and user ID', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(mockCreatedOrder);
      const mockReq = { user: testUser } as any;

      const result = await controller.getOrderByNumber(mockReq, mockCreatedOrder.orderNumber);
      expect(result.orderNumber).toBe(mockCreatedOrder.orderNumber);
    });
  });

  describe('Webhook & Order Finalization Integration', () => {
    let webhookService: WebhookService;
    let mockPaymentService: any;
    let mockAuditService: any;

    beforeEach(() => {
      mockPaymentService = {
        transitionStatusSystem: vi.fn().mockResolvedValue({ id: 'attempt-1' }),
      };
      mockAuditService = {
        logEvent: vi.fn().mockResolvedValue(undefined),
      };

      const webhookPrismaMock = {
        webhookEvent: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'evt-rec-1' }),
          update: vi.fn().mockResolvedValue({ id: 'evt-rec-1' }),
        },
        paymentAttempt: {
          findFirst: vi.fn().mockResolvedValue(mockAttempt),
        },
      };

      webhookService = new WebhookService(
        webhookPrismaMock as any,
        mockAuditService,
        mockPaymentService,
        orderService,
      );
    });

    it('triggers OrderService.finalizeFromPayment when payment.captured webhook is processed', async () => {
      vi.spyOn(orderService, 'finalizeFromPayment').mockResolvedValueOnce({
        ...mockCreatedOrder,
        shipping: {},
        items: [],
      } as any);

      const res = await webhookService.processWebhookEvent(
        'RAZORPAY',
        'evt_official_123',
        {
          eventType: 'payment.captured',
          razorpayOrderId: 'order_rzp_123',
          razorpayPaymentId: 'pay_rzp_456',
          amountPaise: 70000,
          currency: 'INR',
          createdAtUnix: Math.floor(Date.now() / 1000),
          failureCode: null,
          failureMessage: null,
        },
        {},
      );

      expect(res).toBe('PROCESSED');
      expect(orderService.finalizeFromPayment).toHaveBeenCalledWith('attempt-1');
    });

    it('still returns PROCESSED even if order finalization fails (prevents infinite retry loops)', async () => {
      vi.spyOn(orderService, 'finalizeFromPayment').mockRejectedValueOnce(
        new Error('Database lock timeout during order creation'),
      );

      const res = await webhookService.processWebhookEvent(
        'RAZORPAY',
        'evt_official_456',
        {
          eventType: 'payment.captured',
          razorpayOrderId: 'order_rzp_123',
          razorpayPaymentId: 'pay_rzp_456',
          amountPaise: 70000,
          currency: 'INR',
          createdAtUnix: Math.floor(Date.now() / 1000),
          failureCode: null,
          failureMessage: null,
        },
        {},
      );

      expect(res).toBe('PROCESSED');
      expect(orderService.finalizeFromPayment).toHaveBeenCalledWith('attempt-1');
    });
  });

  describe('Transactional Cart Cleanup (Phase 20D.8.1)', () => {
    it('atomically removes purchased cart items from active cart during finalization', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      mockPrisma.cartItem.findUnique.mockResolvedValue({
        id: 'ci-1',
        cartId: 'cart-uuid-1',
        productVariantId: 'var-1',
        quantity: 2,
      });

      const result = await orderService.finalizeFromPayment('attempt-1');

      expect(result).toBeDefined();
      expect(mockPrisma.cartItem.findUnique).toHaveBeenCalledWith({
        where: {
          cartId_productVariantId: {
            cartId: 'cart-uuid-1',
            productVariantId: 'var-1',
          },
        },
      });
      expect(mockPrisma.cartItem.delete).toHaveBeenCalledWith({
        where: { id: 'ci-1' },
      });
      expect(mockPrisma.cartItem.update).not.toHaveBeenCalled();
    });

    it('decrements cart quantity when cart has more quantity than purchased in checkout snapshot', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      // Customer had 5 in cart, but checkout session only purchased 2
      mockPrisma.cartItem.findUnique.mockResolvedValue({
        id: 'ci-1',
        cartId: 'cart-uuid-1',
        productVariantId: 'var-1',
        quantity: 5,
      });

      const result = await orderService.finalizeFromPayment('attempt-1');

      expect(result).toBeDefined();
      expect(mockPrisma.cartItem.update).toHaveBeenCalledWith({
        where: { id: 'ci-1' },
        data: { quantity: 3 }, // 5 - 2 = 3
      });
      expect(mockPrisma.cartItem.delete).not.toHaveBeenCalled();
    });

    it('preserves unrelated or subsequently added items in the cart', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      mockPrisma.cartItem.findUnique.mockResolvedValue({
        id: 'ci-1',
        cartId: 'cart-uuid-1',
        productVariantId: 'var-1',
        quantity: 2,
      });

      await orderService.finalizeFromPayment('attempt-1');

      // The checkout session snapshot items only contain var-1 (not var-unrelated)
      // Assert findUnique was only queried for the purchased variant
      const queriedVariants = mockPrisma.cartItem.findUnique.mock.calls.map(
        (c: any) => c[0].where.cartId_productVariantId.productVariantId,
      );
      expect(queriedVariants).toEqual(['var-1']);
      expect(queriedVariants).not.toContain('var-unrelated');
    });

    it('safely skips cart cleanup if checkout session has no cartId', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
        ...mockAttempt,
        checkoutSession: {
          ...mockSession,
          cartId: null,
        },
      });

      const result = await orderService.finalizeFromPayment('attempt-1');

      expect(result).toBeDefined();
      expect(mockPrisma.cartItem.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.cartItem.delete).not.toHaveBeenCalled();
      expect(mockPrisma.cartItem.update).not.toHaveBeenCalled();
    });

    it('does not clear cart when payment is not captured (failed or pending)', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce({
        ...mockAttempt,
        status: PaymentStatus.FAILED,
      });

      await expect(orderService.finalizeFromPayment('attempt-1')).rejects.toThrow(
        OrderFinalizationError,
      );

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.cartItem.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.cartItem.delete).not.toHaveBeenCalled();
    });

    it('does not delete cart items again on idempotent duplicate finalization', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockCreatedOrder);

      const result = await orderService.finalizeFromPayment('attempt-1');

      expect(result.id).toBe(mockCreatedOrder.id);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.cartItem.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.cartItem.delete).not.toHaveBeenCalled();
    });
  });
});

