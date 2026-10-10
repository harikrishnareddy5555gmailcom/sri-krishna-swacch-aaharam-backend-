import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, PaymentStatus } from '@prisma/client';
import {
  AuditAction,
  AuditEntityType,
  UserRole,
  Permissions,
  OrderStatus,
} from '@vishkaraa/types';
import { OrderService } from '../src/orders/orders.service.js';
import { AdminOrdersController } from '../src/orders/admin-orders.controller.js';
import type { MinimalUser } from '../src/permissions/permissions.service.js';

describe('Admin Orders & State Machine — Phase 08B', () => {
  let orderService: OrderService;
  let adminOrdersController: AdminOrdersController;
  let mockPrisma: any;
  let mockPermissionsService: any;

  const superAdminUser: MinimalUser = {
    id: 'super-admin-uuid-1',
    role: UserRole.SUPER_ADMIN,
    email: 'superadmin@vishkaraa.local',
  };

  const adminWithViewAndUpdate: MinimalUser = {
    id: 'admin-uuid-1',
    role: UserRole.ADMIN,
    email: 'admin1@vishkaraa.local',
  };

  const adminWithCancelOnly: MinimalUser = {
    id: 'admin-uuid-2',
    role: UserRole.ADMIN,
    email: 'admin2@vishkaraa.local',
  };

  const regularUser: MinimalUser = {
    id: 'user-uuid-1',
    role: UserRole.USER,
    email: 'shopper@vishkaraa.local',
  };

  const baseOrder = {
    id: 'order-uuid-1',
    orderNumber: 'VN-202609-A1B2C3D4',
    userId: 'user-uuid-1',
    checkoutSessionId: 'sess-uuid-1',
    paymentAttemptId: 'attempt-uuid-1',
    status: OrderStatus.CONFIRMED,
    subtotal: 70000,
    tax: 0,
    discount: 0,
    totalAmount: 70000,
    currency: 'INR',
    shippingName: 'Ananya Sharma',
    shippingPhone: '+919876543210',
    shippingLine1: '123 Herbal Way',
    shippingLine2: null,
    shippingCity: 'Bengaluru',
    shippingState: 'Karnataka',
    shippingPostalCode: '560001',
    shippingCountry: 'IN',
    confirmedAt: new Date('2026-09-29T10:00:00Z'),
    cancelledAt: null,
    notes: null,
    createdAt: new Date('2026-09-29T10:00:00Z'),
    updatedAt: new Date('2026-09-29T10:00:00Z'),
    items: [
      {
        id: 'item-1',
        orderId: 'order-uuid-1',
        productId: 'prod-1',
        variantId: 'var-1',
        productName: 'Kumkumadi Tailam',
        variantName: '30ml',
        productSku: 'KUMKUMADI-30ML',
        primaryImageUrl: 'https://images.vishkaraa.com/kumkumadi.jpg',
        quantity: 1,
        unitPrice: 70000,
        lineTotal: 70000,
        currency: 'INR',
        createdAt: new Date('2026-09-29T10:00:00Z'),
      },
    ],
    paymentAttempt: {
      id: 'attempt-uuid-1',
      checkoutSessionId: 'sess-uuid-1',
      provider: 'RAZORPAY',
      providerOrderId: 'order_rzp_12345',
      providerPaymentId: 'pay_rzp_67890',
      status: PaymentStatus.CAPTURED,
      amount: 70000,
      currency: 'INR',
      createdAt: new Date('2026-09-29T09:59:00Z'),
      updatedAt: new Date('2026-09-29T10:00:00Z'),
    },
    user: {
      id: 'user-uuid-1',
      email: 'shopper@vishkaraa.local',
      firstName: 'Ananya',
      lastName: 'Sharma',
    },
    auditLogs: [],
  };

  beforeEach(() => {
    mockPrisma = {
      order: {
        findMany: vi.fn().mockResolvedValue([baseOrder]),
        count: vi.fn().mockResolvedValue(1),
        findUnique: vi.fn().mockResolvedValue(baseOrder),
        findUniqueOrThrow: vi.fn().mockResolvedValue(baseOrder),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        groupBy: vi.fn().mockResolvedValue([
          { status: OrderStatus.CONFIRMED, _count: { id: 3 } },
          { status: OrderStatus.PROCESSING, _count: { id: 7 } },
          { status: OrderStatus.SHIPPED, _count: { id: 4 } },
          { status: OrderStatus.DELIVERED, _count: { id: 10 } },
          { status: OrderStatus.CANCELLED, _count: { id: 1 } },
        ]),
        aggregate: vi.fn().mockResolvedValue({
          _sum: { totalAmount: 2500000 },
        }),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: 'audit-uuid-1' }),
      },
      $transaction: vi.fn().mockImplementation(async (arg) => {
        if (typeof arg === 'function') {
          return arg(mockPrisma);
        }
        return Promise.all(arg);
      }),
    };

    mockPermissionsService = {
      can: vi.fn().mockImplementation(async (user: MinimalUser, perm: string) => {
        if (user.role === UserRole.SUPER_ADMIN) return true;
        if (user.id === adminWithViewAndUpdate.id) {
          return perm === Permissions.ORDERS_VIEW || perm === Permissions.ORDERS_UPDATE;
        }
        if (user.id === adminWithCancelOnly.id) {
          return perm === Permissions.ORDERS_VIEW || perm === Permissions.ORDERS_CANCEL;
        }
        return false;
      }),
    };

    orderService = new OrderService(mockPrisma as any);
    adminOrdersController = new AdminOrdersController(orderService, mockPermissionsService as any);
  });

  // ===========================================================================
  // 1. ADMIN LISTING & QUERYING
  // ===========================================================================
  describe('Admin Order Listing (adminGetOrders)', () => {
    it('returns paginated order list with customer summary and counts', async () => {
      const result = await orderService.adminGetOrders({ page: 1, limit: 20 });

      expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 20,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
      expect(result.orders).toHaveLength(1);
      expect(result.orders[0]!.orderNumber).toBe('VN-202609-A1B2C3D4');
      expect(result.orders[0]!.customer?.email).toBe('shopper@vishkaraa.local');
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('filters by status when provided', async () => {
      await orderService.adminGetOrders({ status: OrderStatus.CONFIRMED });

      expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: OrderStatus.CONFIRMED }),
        }),
      );
    });

    it('searches by orderNumber, shipping name, phone, or email', async () => {
      await orderService.adminGetOrders({ search: 'Ananya' });

      expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { orderNumber: { contains: 'Ananya', mode: 'insensitive' } },
              { shippingName: { contains: 'Ananya', mode: 'insensitive' } },
              { shippingPhone: { contains: 'Ananya', mode: 'insensitive' } },
              { user: { email: { contains: 'Ananya', mode: 'insensitive' } } },
            ],
          }),
        }),
      );
    });

    it('filters by date range (fromDate, toDate)', async () => {
      await orderService.adminGetOrders({
        fromDate: '2026-09-01T00:00:00Z',
        toDate: '2026-09-30T23:59:59Z',
      });

      expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: {
              gte: new Date('2026-09-01T00:00:00Z'),
              lte: new Date('2026-09-30T23:59:59Z'),
            },
          }),
        }),
      );
    });

    it('clamps limit between 1 and 100', async () => {
      await orderService.adminGetOrders({ page: 1, limit: 500 });

      expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  // ===========================================================================
  // 2. ADMIN DETAIL & OPERATIONAL REFERENCES
  // ===========================================================================
  describe('Admin Order Detail (adminGetOrderById)', () => {
    it('returns full order detail with operational payment references and audit trail', async () => {
      const result = await orderService.adminGetOrderById('order-uuid-1');

      expect(result.id).toBe('order-uuid-1');
      expect(result.customer?.email).toBe('shopper@vishkaraa.local');
      expect(result.operationalPayment).toBeDefined();
      expect(result.operationalPayment?.provider).toBe('RAZORPAY');
      expect(result.operationalPayment?.providerOrderId).toBe('order_rzp_12345');
      expect(result.operationalPayment?.providerPaymentId).toBe('pay_rzp_67890');
      expect(result.operationalPayment?.status).toBe(PaymentStatus.CAPTURED);
    });

    it('throws NotFoundException when order does not exist', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(null);

      await expect(orderService.adminGetOrderById('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ===========================================================================
  // 3. STATE MACHINE TRANSITIONS
  // ===========================================================================
  describe('Order State Machine & Transitions (updateOrderStatus)', () => {
    it('allows valid transition: CONFIRMED -> PROCESSING', async () => {
      const updatedOrder = {
        ...baseOrder,
        status: OrderStatus.PROCESSING,
      };
      mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce(updatedOrder);

      const result = await orderService.updateOrderStatus(
        'order-uuid-1',
        adminWithViewAndUpdate,
        { status: OrderStatus.PROCESSING, notes: 'Packing station assigned' },
      );

      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-uuid-1', status: OrderStatus.CONFIRMED },
        data: expect.objectContaining({
          status: OrderStatus.PROCESSING,
          notes: 'Packing station assigned',
        }),
      });
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: AuditAction.ORDER_STATUS_CHANGED_ADMIN,
          entityType: AuditEntityType.ORDER,
          entityId: 'order-uuid-1',
          previousValue: JSON.stringify({ status: OrderStatus.CONFIRMED }),
          newValue: expect.stringContaining(OrderStatus.PROCESSING),
        }),
      });
      expect(result.status).toBe(OrderStatus.PROCESSING);
    });

    it('allows valid transition: PROCESSING -> SHIPPED', async () => {
      const processingOrder = { ...baseOrder, status: OrderStatus.PROCESSING };
      mockPrisma.order.findUnique.mockResolvedValueOnce(processingOrder);
      mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({
        ...processingOrder,
        status: OrderStatus.SHIPPED,
      });

      const result = await orderService.updateOrderStatus(
        'order-uuid-1',
        adminWithViewAndUpdate,
        { status: OrderStatus.SHIPPED },
      );

      expect(result.status).toBe(OrderStatus.SHIPPED);
    });

    it('allows valid transition: SHIPPED -> DELIVERED', async () => {
      const shippedOrder = { ...baseOrder, status: OrderStatus.SHIPPED };
      mockPrisma.order.findUnique.mockResolvedValueOnce(shippedOrder);
      mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({
        ...shippedOrder,
        status: OrderStatus.DELIVERED,
      });

      const result = await orderService.updateOrderStatus(
        'order-uuid-1',
        adminWithViewAndUpdate,
        { status: OrderStatus.DELIVERED },
      );

      expect(result.status).toBe(OrderStatus.DELIVERED);
    });

    it('allows cancellation: CONFIRMED -> CANCELLED (requires reason, sets cancelledAt, leaves PaymentAttempt CAPTURED)', async () => {
      const cancelledOrder = {
        ...baseOrder,
        status: OrderStatus.CANCELLED,
        cancelledAt: new Date('2026-09-29T11:00:00Z'),
      };
      mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce(cancelledOrder);

      const result = await orderService.updateOrderStatus(
        'order-uuid-1',
        adminWithCancelOnly,
        { status: OrderStatus.CANCELLED, reason: 'Customer requested order cancellation before packing' },
      );

      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-uuid-1', status: OrderStatus.CONFIRMED },
        data: expect.objectContaining({
          status: OrderStatus.CANCELLED,
          cancelledAt: expect.any(Date),
        }),
      });

      // Audit verifies ORDER_CANCELLED
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: AuditAction.ORDER_CANCELLED,
          entityType: AuditEntityType.ORDER,
          reason: 'Customer requested order cancellation before packing',
          metadata: expect.objectContaining({
            refundStatus: 'NO_REFUND_IN_PHASE_08',
          }),
        }),
      });

      expect(result.status).toBe(OrderStatus.CANCELLED);
    });

    it('allows cancellation: PROCESSING -> CANCELLED', async () => {
      const processingOrder = { ...baseOrder, status: OrderStatus.PROCESSING };
      mockPrisma.order.findUnique.mockResolvedValueOnce(processingOrder);
      mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce({
        ...processingOrder,
        status: OrderStatus.CANCELLED,
        cancelledAt: new Date(),
      });

      const result = await orderService.updateOrderStatus(
        'order-uuid-1',
        adminWithCancelOnly,
        { status: OrderStatus.CANCELLED, reason: 'Damaged packaging during dispatch prep' },
      );

      expect(result.status).toBe(OrderStatus.CANCELLED);
    });

    it('rejects cancellation without reason (at least 3 characters)', async () => {
      await expect(
        orderService.updateOrderStatus('order-uuid-1', adminWithCancelOnly, {
          status: OrderStatus.CANCELLED,
          reason: '  ',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        orderService.updateOrderStatus('order-uuid-1', adminWithCancelOnly, {
          status: OrderStatus.CANCELLED,
          reason: 'no',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects forbidden transition: SHIPPED -> CANCELLED (in-transit)', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce({
        ...baseOrder,
        status: OrderStatus.SHIPPED,
      });

      await expect(
        orderService.updateOrderStatus('order-uuid-1', adminWithCancelOnly, {
          status: OrderStatus.CANCELLED,
          reason: 'Trying to cancel shipped item',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects invalid state skips: CONFIRMED -> SHIPPED, CONFIRMED -> DELIVERED', async () => {
      await expect(
        orderService.updateOrderStatus('order-uuid-1', adminWithViewAndUpdate, {
          status: OrderStatus.SHIPPED,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        orderService.updateOrderStatus('order-uuid-1', adminWithViewAndUpdate, {
          status: OrderStatus.DELIVERED,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects modification from terminal state: DELIVERED -> anything', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce({
        ...baseOrder,
        status: OrderStatus.DELIVERED,
      });

      await expect(
        orderService.updateOrderStatus('order-uuid-1', adminWithViewAndUpdate, {
          status: OrderStatus.PROCESSING,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects modification from terminal state: CANCELLED -> anything', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce({
        ...baseOrder,
        status: OrderStatus.CANCELLED,
      });

      await expect(
        orderService.updateOrderStatus('order-uuid-1', adminWithViewAndUpdate, {
          status: OrderStatus.CONFIRMED,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('is idempotent: same status is a safe no-op without writing duplicate audit', async () => {
      const result = await orderService.updateOrderStatus(
        'order-uuid-1',
        adminWithViewAndUpdate,
        { status: OrderStatus.CONFIRMED },
      );

      expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
      expect(result.status).toBe(OrderStatus.CONFIRMED);
    });

    it('throws 409 Conflict if order was concurrently modified by another transaction', async () => {
      // Simulate updateMany returning 0 rows because status changed concurrently
      mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
      // Re-read shows it was changed to SHIPPED
      mockPrisma.order.findUnique
        .mockResolvedValueOnce(baseOrder) // Initial read: CONFIRMED
        .mockResolvedValueOnce({ ...baseOrder, status: OrderStatus.SHIPPED }); // Re-read: SHIPPED

      await expect(
        orderService.updateOrderStatus('order-uuid-1', adminWithViewAndUpdate, {
          status: OrderStatus.PROCESSING,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ===========================================================================
  // 4. ADMIN CONTROLLER PERMISSIONS & AUTHORIZATION
  // ===========================================================================
  describe('AdminOrdersController Authorization & Permissions', () => {
    it('allows Admin with ORDERS.UPDATE to transition to PROCESSING', async () => {
      const req: any = { user: adminWithViewAndUpdate };
      const body = { status: OrderStatus.PROCESSING, notes: 'Packing' };

      const result = await adminOrdersController.updateOrderStatus(req, 'order-uuid-1', body);

      expect(result).toBeDefined();
      expect(mockPermissionsService.can).toHaveBeenCalledWith(
        adminWithViewAndUpdate,
        Permissions.ORDERS_UPDATE,
      );
    });

    it('forbids Admin without ORDERS.UPDATE when transitioning to PROCESSING (403)', async () => {
      const req: any = { user: adminWithCancelOnly }; // lacks ORDERS.UPDATE
      const body = { status: OrderStatus.PROCESSING };

      await expect(
        adminOrdersController.updateOrderStatus(req, 'order-uuid-1', body),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows Admin with ORDERS.CANCEL to transition to CANCELLED', async () => {
      const req: any = { user: adminWithCancelOnly };
      const body = { status: OrderStatus.CANCELLED, reason: 'Valid admin cancel reason' };

      const result = await adminOrdersController.updateOrderStatus(req, 'order-uuid-1', body);

      expect(result).toBeDefined();
      expect(mockPermissionsService.can).toHaveBeenCalledWith(
        adminWithCancelOnly,
        Permissions.ORDERS_CANCEL,
      );
    });

    it('forbids Admin without ORDERS.CANCEL when attempting cancellation (403)', async () => {
      const req: any = { user: adminWithViewAndUpdate }; // lacks ORDERS.CANCEL
      const body = { status: OrderStatus.CANCELLED, reason: 'Attempting cancel' };

      await expect(
        adminOrdersController.updateOrderStatus(req, 'order-uuid-1', body),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows SUPER_ADMIN to execute both fulfillment updates and cancellations', async () => {
      const req: any = { user: superAdminUser };

      const procResult = await adminOrdersController.updateOrderStatus(req, 'order-uuid-1', {
        status: OrderStatus.PROCESSING,
      });
      expect(procResult).toBeDefined();

      const cancelResult = await adminOrdersController.updateOrderStatus(req, 'order-uuid-1', {
        status: OrderStatus.CANCELLED,
        reason: 'Super admin cancel',
      });
      expect(cancelResult).toBeDefined();
    });
  });

  describe('GET /admin/orders/summary (Phase 1 Dashboard Command Center)', () => {
    it('returns order counts breakdown and today revenue paise', async () => {
      const summary = await orderService.getOrderSummary();

      expect(summary).toEqual({
        confirmed: 3,
        processing: 7,
        shipped: 4,
        delivered: 10,
        cancelled: 1,
        todayRevenuePaise: 2500000,
        totalOrders: 25,
      });

      expect(mockPrisma.order.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        _count: { id: true },
      });
      expect(mockPrisma.order.aggregate).toHaveBeenCalled();
    });

    it('delegates from controller to service correctly', async () => {
      const summary = await adminOrdersController.getOrderSummary();

      expect(summary).toHaveProperty('confirmed', 3);
      expect(summary).toHaveProperty('processing', 7);
      expect(summary).toHaveProperty('shipped', 4);
      expect(summary).toHaveProperty('delivered', 10);
      expect(summary).toHaveProperty('todayRevenuePaise', 2500000);
      expect(summary).toHaveProperty('totalOrders', 25);
    });

    it('handles zero revenue and missing statuses safely without NaN or undefined', async () => {
      mockPrisma.order.groupBy.mockResolvedValueOnce([]);
      mockPrisma.order.aggregate.mockResolvedValueOnce({ _sum: { totalAmount: null } });

      const summary = await orderService.getOrderSummary();

      expect(summary).toEqual({
        confirmed: 0,
        processing: 0,
        shipped: 0,
        delivered: 0,
        cancelled: 0,
        todayRevenuePaise: 0,
        totalOrders: 0,
      });
    });
  });
});
