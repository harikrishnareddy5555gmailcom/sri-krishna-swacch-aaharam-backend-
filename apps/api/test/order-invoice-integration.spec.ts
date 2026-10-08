import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma, PaymentStatus, CheckoutStatus, OrderStatus, InvoiceStatus } from '@prisma/client';
import { AuditAction, AuditEntityType, UserRole } from '@vishkaraa/types';
import { OrderService } from '../src/orders/orders.service.js';
import { InvoiceService } from '../src/invoices/invoices.service.js';
import { InventoryService } from '../src/inventory/inventory.service.js';

describe('Order → Invoice Unit Integration (Phase 12 Stage 12C)', () => {
  let orderService: OrderService;
  let mockPrisma: any;
  let mockInvoiceService: any;
  let mockInventoryService: any;

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
    deliveredAt: null,
    notes: null,
    createdAt: new Date('2026-09-29T10:06:00Z'),
    updatedAt: new Date('2026-09-29T10:06:00Z'),
    items: [
      {
        id: 'order-item-1',
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
    vi.clearAllMocks();

    mockPrisma = {
      order: {
        findUnique: vi.fn().mockResolvedValue(null),
        findUniqueOrThrow: vi.fn().mockResolvedValue(mockCreatedOrder),
        create: vi.fn().mockResolvedValue(mockCreatedOrder),
      },
      orderItem: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue(mockCreatedOrder.items),
      },
      checkoutSession: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
            auditLog: mockPrisma.auditLog,
          });
        }
        return arg;
      }),
    };

    mockInvoiceService = {
      createInvoiceInTransaction: vi.fn().mockResolvedValue({
        id: 'inv-1',
        invoiceNumber: 'VN-INV-202609-12345678',
        orderId: mockCreatedOrder.id,
        grandTotal: 70000,
      }),
    };

    mockInventoryService = {
      commitReservation: vi.fn().mockResolvedValue(undefined),
    };

    orderService = new OrderService(
      mockPrisma,
      mockInventoryService as unknown as InventoryService,
      mockInvoiceService as unknown as InvoiceService,
    );
  });

  it('atomically creates order and calls createInvoiceInTransaction in same transaction client', async () => {
    const result = await orderService.finalizeFromPayment('attempt-1');

    expect(result).toBeDefined();
    expect(result.id).toBe(mockCreatedOrder.id);
    expect(result.status).toBe(OrderStatus.CONFIRMED);

    // Verify inventory commit was called inside transaction
    expect(mockInventoryService.commitReservation).toHaveBeenCalledWith(
      'sess-1',
      mockCreatedOrder.id,
      'user-uuid-1',
      expect.anything(),
    );

    // Verify invoice service was called with the order snapshot and transaction client
    expect(mockInvoiceService.createInvoiceInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        id: mockCreatedOrder.id,
        items: expect.arrayContaining([
          expect.objectContaining({
            productSku: 'SESAME-500ML',
            lineTotal: 70000,
          }),
        ]),
      }),
      expect.anything(),
      'user-uuid-1',
    );
  });

  it('fails order finalization if createInvoiceInTransaction throws an error (atomic rollback)', async () => {
    mockInvoiceService.createInvoiceInTransaction.mockRejectedValueOnce(
      new Error('Invoice generation failed'),
    );

    await expect(orderService.finalizeFromPayment('attempt-1')).rejects.toThrow(
      'Invoice generation failed',
    );
  });

  it('does not call invoice creation if order already exists on idempotency fast path', async () => {
    mockPrisma.order.findUnique.mockResolvedValueOnce(mockCreatedOrder);

    const result = await orderService.finalizeFromPayment('attempt-1');

    expect(result.id).toBe(mockCreatedOrder.id);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockInvoiceService.createInvoiceInTransaction).not.toHaveBeenCalled();
  });
});
