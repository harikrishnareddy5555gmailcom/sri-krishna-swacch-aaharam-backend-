import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { OrderStatus, InvoiceStatus, Prisma } from '@prisma/client';
import { AuditAction, AuditEntityType, Permissions, UserRole } from '@vishkaraa/types';
import { InvoiceService, generateInvoiceNumber, DEFAULT_SELLER_SNAPSHOT } from '../src/invoices/invoices.service.js';
import type { MinimalUser } from '../src/permissions/permissions.service.js';

describe('Phase 12: Stage 12B — Invoice Domain & Service', () => {
  let invoiceService: InvoiceService;
  let mockPrisma: any;
  let mockAuditService: any;
  let mockPermissionsService: any;

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

  const adminUser: MinimalUser = {
    id: 'admin-uuid-1',
    role: UserRole.ADMIN,
    email: 'admin@vishkaraa.local',
  };

  const superAdminUser: MinimalUser = {
    id: 'super-admin-uuid',
    role: UserRole.SUPER_ADMIN,
    email: 'superadmin@vishkaraa.local',
  };

  const mockOrderItem = {
    id: 'order-item-1',
    orderId: 'order-1',
    productId: 'prod-1',
    variantId: 'var-1',
    productName: 'Herbal Hair Oil',
    variantName: '200ml',
    productSku: 'HHO-200ML',
    quantity: 2,
    unitPrice: 45000,
    lineTotal: 90000,
    currency: 'INR',
    createdAt: new Date('2026-09-29T10:00:00Z'),
  };

  const mockOrder = {
    id: 'order-1',
    orderNumber: 'VN-202609-ABCD1234',
    userId: 'user-uuid-1',
    checkoutSessionId: 'sess-1',
    paymentAttemptId: 'attempt-1',
    status: OrderStatus.CONFIRMED,
    subtotal: 90000,
    discount: 0,
    tax: 0,
    totalAmount: 90000,
    currency: 'INR',
    shippingName: 'Hari Raman',
    shippingPhone: '+919876543210',
    shippingLine1: '123 Natural Way',
    shippingLine2: 'Suite 4',
    shippingCity: 'Bengaluru',
    shippingState: 'Karnataka',
    shippingPostalCode: '560001',
    shippingCountry: 'IN',
    items: [mockOrderItem],
    createdAt: new Date('2026-09-29T10:00:00Z'),
    updatedAt: new Date('2026-09-29T10:00:00Z'),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockPrisma = {
      invoice: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        count: vi.fn(),
      },
      order: {
        findUnique: vi.fn(),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      },
      $transaction: vi.fn().mockImplementation(async (callback: any) => {
        return callback(mockPrisma);
      }),
    };

    mockAuditService = {
      logEvent: vi.fn().mockResolvedValue(undefined),
    };

    mockPermissionsService = {
      can: vi.fn().mockImplementation(async (user: MinimalUser, permissionKey: string) => {
        if (user.role === UserRole.SUPER_ADMIN) return true;
        if (user.role === UserRole.ADMIN && (permissionKey === Permissions.INVOICES_VIEW || permissionKey === Permissions.INVOICES_MANAGE)) {
          return true;
        }
        return false;
      }),
    };

    invoiceService = new InvoiceService(
      mockPrisma as any,
      mockAuditService as any,
      mockPermissionsService as any,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // A. Create invoice from finalized order
  // ───────────────────────────────────────────────────────────────────────────
  it('A. creates invoice from finalized order with complete historical snapshot', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(null); // idempotency check
    mockPrisma.order.findUnique.mockResolvedValueOnce(mockOrder);

    mockPrisma.invoice.create.mockResolvedValueOnce({
      id: 'inv-1',
      invoiceNumber: 'VN-INV-202609-12345678',
      orderId: mockOrder.id,
      userId: mockOrder.userId,
      status: InvoiceStatus.ISSUED,
      currency: 'INR',
      subtotal: 90000,
      discountTotal: 0,
      shippingTotal: 0,
      taxTotal: 0,
      grandTotal: 90000,
      billingName: mockOrder.shippingName,
      billingPhone: mockOrder.shippingPhone,
      billingLine1: mockOrder.shippingLine1,
      billingLine2: mockOrder.shippingLine2,
      billingCity: mockOrder.shippingCity,
      billingState: mockOrder.shippingState,
      billingPostalCode: mockOrder.shippingPostalCode,
      billingCountry: mockOrder.shippingCountry,
      billingSnapshot: {
        name: mockOrder.shippingName,
        city: mockOrder.shippingCity,
      },
      sellerName: DEFAULT_SELLER_SNAPSHOT.sellerName,
      sellerAddressLine1: DEFAULT_SELLER_SNAPSHOT.sellerAddressLine1,
      sellerCity: DEFAULT_SELLER_SNAPSHOT.sellerCity,
      sellerCountry: DEFAULT_SELLER_SNAPSHOT.sellerCountry,
      sellerSnapshot: DEFAULT_SELLER_SNAPSHOT,
      customerGstin: null,
      placeOfSupply: null,
      isReverseCharge: false,
      invoiceType: 'REGULAR',
      issuedAt: new Date('2026-09-29T10:05:00Z'),
      cancelledAt: null,
      createdAt: new Date('2026-09-29T10:05:00Z'),
      updatedAt: new Date('2026-09-29T10:05:00Z'),
      order: { orderNumber: mockOrder.orderNumber },
      items: [
        {
          id: 'inv-item-1',
          invoiceId: 'inv-1',
          orderItemId: mockOrderItem.id,
          productId: mockOrderItem.productId,
          variantId: mockOrderItem.variantId,
          productName: mockOrderItem.productName,
          variantName: mockOrderItem.variantName,
          productSku: mockOrderItem.productSku,
          quantity: mockOrderItem.quantity,
          unitPrice: mockOrderItem.unitPrice,
          discountAmount: 0,
          taxableAmount: mockOrderItem.lineTotal,
          taxAmount: 0,
          lineTotal: mockOrderItem.lineTotal,
          currency: 'INR',
          createdAt: new Date('2026-09-29T10:05:00Z'),
        },
      ],
    });

    const invoice = await invoiceService.createInvoiceForOrder(mockOrder.id);

    expect(invoice.id).toBe('inv-1');
    expect(invoice.orderId).toBe(mockOrder.id);
    expect(invoice.orderNumber).toBe(mockOrder.orderNumber);
    expect(invoice.userId).toBe(mockOrder.userId);
    expect(invoice.status).toBe(InvoiceStatus.ISSUED);
    expect(invoice.grandTotal).toBe(90000);
    expect(invoice.subtotal).toBe(90000);
    expect(invoice.billingName).toBe('Hari Raman');
    expect(invoice.items).toHaveLength(1);
    expect(invoice.items![0]!.productSku).toBe('HHO-200ML');
    expect(invoice.items![0]!.lineTotal).toBe(90000);

    // Verify audit record inside transaction
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: AuditAction.INVOICE_ISSUED,
          entityType: AuditEntityType.INVOICE,
          entityId: 'inv-1',
          orderId: mockOrder.id,
          amount: 90000,
        }),
      }),
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B. Cannot create invoice from non-finalized or cancelled order
  // ───────────────────────────────────────────────────────────────────────────
  it('B. rejects invoice creation for cancelled order', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(null);
    mockPrisma.order.findUnique.mockResolvedValueOnce({
      ...mockOrder,
      status: OrderStatus.CANCELLED,
    });

    await expect(invoiceService.createInvoiceForOrder(mockOrder.id)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('B2. rejects invoice creation for non-existent order', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(null);
    mockPrisma.order.findUnique.mockResolvedValueOnce(null);

    await expect(invoiceService.createInvoiceForOrder('non-existent')).rejects.toThrow(
      NotFoundException,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C. Failed payment produces no invoice
  // ───────────────────────────────────────────────────────────────────────────
  it('C. does not trigger invoice creation when order does not exist (failed payment boundary)', async () => {
    // Under failed payment, OrderService.finalizeFromPayment throws before creating an Order.
    // If invoiceService is asked to create invoice for an attempt that never created an order, it throws NotFoundException.
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(null);
    mockPrisma.order.findUnique.mockResolvedValueOnce(null);

    await expect(invoiceService.createInvoiceForOrder('order-from-failed-payment')).rejects.toThrow(
      NotFoundException,
    );
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // D. Repeated creation is idempotent
  // ───────────────────────────────────────────────────────────────────────────
  it('D. returns existing invoice on repeated creation (idempotency)', async () => {
    const existingInvoice = {
      id: 'inv-existing',
      invoiceNumber: 'VN-INV-202609-EXISTING',
      orderId: mockOrder.id,
      userId: mockOrder.userId,
      status: InvoiceStatus.ISSUED,
      currency: 'INR',
      subtotal: 90000,
      discountTotal: 0,
      shippingTotal: 0,
      taxTotal: 0,
      grandTotal: 90000,
      issuedAt: new Date('2026-09-29T10:00:00Z'),
      createdAt: new Date('2026-09-29T10:00:00Z'),
      updatedAt: new Date('2026-09-29T10:00:00Z'),
      order: { orderNumber: mockOrder.orderNumber },
      items: [],
    };

    mockPrisma.invoice.findUnique.mockResolvedValueOnce(existingInvoice);

    const result = await invoiceService.createInvoiceForOrder(mockOrder.id);

    expect(result.id).toBe('inv-existing');
    expect(result.invoiceNumber).toBe('VN-INV-202609-EXISTING');
    // Verify no secondary create was called
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // F. Invoice number format and uniqueness
  // ───────────────────────────────────────────────────────────────────────────
  it('F. generates human-readable invoice numbers in format VN-INV-YYYYMM-XXXXXXXX', () => {
    const number1 = generateInvoiceNumber();
    const number2 = generateInvoiceNumber();

    expect(number1).toMatch(/^VN-INV-\d{6}-[A-F0-9]{8}$/);
    expect(number2).toMatch(/^VN-INV-\d{6}-[A-F0-9]{8}$/);
    expect(number1).not.toBe(number2);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // H. Invoice item snapshot remains independent of current Product changes
  // ───────────────────────────────────────────────────────────────────────────
  it('H. snapshots item data directly from OrderItem, independent of catalog product changes', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(null);
    mockPrisma.order.findUnique.mockResolvedValueOnce(mockOrder);

    mockPrisma.invoice.create.mockImplementationOnce(({ data }: any) => {
      return {
        id: 'inv-snapshot-test',
        invoiceNumber: 'VN-INV-202609-SNAPTEST',
        ...data,
        issuedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        order: { orderNumber: mockOrder.orderNumber },
        items: data.items.create.map((it: any, idx: number) => ({
          id: `inv-item-${idx}`,
          invoiceId: 'inv-snapshot-test',
          ...it,
          createdAt: new Date(),
        })),
      };
    });

    const invoice = await invoiceService.createInvoiceForOrder(mockOrder.id);

    // Verify snapshot fields
    expect(invoice.items![0]!.productName).toBe(mockOrderItem.productName);
    expect(invoice.items![0]!.productSku).toBe(mockOrderItem.productSku);
    expect(invoice.items![0]!.unitPrice).toBe(mockOrderItem.unitPrice);
    expect(invoice.items![0]!.lineTotal).toBe(mockOrderItem.lineTotal);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // I & J. Customer ownership and IDOR protection
  // ───────────────────────────────────────────────────────────────────────────
  it('I. allows customer to access their own invoice', async () => {
    const existingInvoice = {
      id: 'inv-1',
      invoiceNumber: 'VN-INV-202609-12345678',
      orderId: mockOrder.id,
      userId: testUser.id,
      status: InvoiceStatus.ISSUED,
      currency: 'INR',
      subtotal: 90000,
      discountTotal: 0,
      shippingTotal: 0,
      taxTotal: 0,
      grandTotal: 90000,
      issuedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [],
      order: { orderNumber: mockOrder.orderNumber },
    };

    mockPrisma.invoice.findUnique.mockResolvedValueOnce(existingInvoice);

    const result = await invoiceService.getInvoiceById('inv-1', testUser);
    expect(result.id).toBe('inv-1');
  });

  it('J. forbids customer from accessing another user\'s invoice (IDOR protection)', async () => {
    const existingInvoice = {
      id: 'inv-1',
      invoiceNumber: 'VN-INV-202609-12345678',
      orderId: mockOrder.id,
      userId: otherUser.id, // Owned by otherUser
      status: InvoiceStatus.ISSUED,
      currency: 'INR',
      subtotal: 90000,
      discountTotal: 0,
      shippingTotal: 0,
      taxTotal: 0,
      grandTotal: 90000,
      issuedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [],
      order: { orderNumber: mockOrder.orderNumber },
    };

    mockPrisma.invoice.findUnique.mockResolvedValueOnce(existingInvoice);

    await expect(invoiceService.getInvoiceById('inv-1', testUser)).rejects.toThrow(
      ForbiddenException,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // K. Admin permission enforcement
  // ───────────────────────────────────────────────────────────────────────────
  it('K. allows Admin with INVOICES.VIEW to access any invoice', async () => {
    const existingInvoice = {
      id: 'inv-1',
      invoiceNumber: 'VN-INV-202609-12345678',
      orderId: mockOrder.id,
      userId: testUser.id,
      status: InvoiceStatus.ISSUED,
      currency: 'INR',
      subtotal: 90000,
      discountTotal: 0,
      shippingTotal: 0,
      taxTotal: 0,
      grandTotal: 90000,
      issuedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [],
      order: { orderNumber: mockOrder.orderNumber },
    };

    mockPrisma.invoice.findUnique.mockResolvedValueOnce(existingInvoice);

    const result = await invoiceService.getInvoiceById('inv-1', adminUser);
    expect(result.id).toBe('inv-1');
  });

  it('K2. allows Super Admin to access any invoice unconditionally', async () => {
    const existingInvoice = {
      id: 'inv-1',
      invoiceNumber: 'VN-INV-202609-12345678',
      orderId: mockOrder.id,
      userId: testUser.id,
      status: InvoiceStatus.ISSUED,
      currency: 'INR',
      subtotal: 90000,
      discountTotal: 0,
      shippingTotal: 0,
      taxTotal: 0,
      grandTotal: 90000,
      issuedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [],
      order: { orderNumber: mockOrder.orderNumber },
    };

    mockPrisma.invoice.findUnique.mockResolvedValueOnce(existingInvoice);

    const result = await invoiceService.getInvoiceById('inv-1', superAdminUser);
    expect(result.id).toBe('inv-1');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // L & M. Financial reconciliation & Currency
  // ───────────────────────────────────────────────────────────────────────────
  it('L. enforces items line total sum matches order subtotal', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(null);
    mockPrisma.order.findUnique.mockResolvedValueOnce({
      ...mockOrder,
      subtotal: 99999, // Mismatched subtotal
    });

    await expect(invoiceService.createInvoiceForOrder(mockOrder.id)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('M. verifies currency matches Order currency', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(null);
    mockPrisma.order.findUnique.mockResolvedValueOnce(mockOrder);

    mockPrisma.invoice.create.mockImplementationOnce(({ data }: any) => ({
      id: 'inv-currency-test',
      ...data,
      issuedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      order: { orderNumber: mockOrder.orderNumber },
      items: [],
    }));

    const result = await invoiceService.createInvoiceForOrder(mockOrder.id);
    expect(result.currency).toBe(mockOrder.currency);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // O & P. Immutability & Cancellation behavior
  // ───────────────────────────────────────────────────────────────────────────
  it('O & P. cancels invoice without mutating historical financial totals', async () => {
    const issuedInvoice = {
      id: 'inv-to-cancel',
      invoiceNumber: 'VN-INV-202609-CANCELME',
      orderId: mockOrder.id,
      userId: testUser.id,
      status: InvoiceStatus.ISSUED,
      currency: 'INR',
      subtotal: 90000,
      discountTotal: 0,
      shippingTotal: 0,
      taxTotal: 0,
      grandTotal: 90000,
      issuedAt: new Date('2026-09-29T10:00:00Z'),
      cancelledAt: null,
      cancelReason: null,
      createdAt: new Date('2026-09-29T10:00:00Z'),
      updatedAt: new Date('2026-09-29T10:00:00Z'),
      order: { orderNumber: mockOrder.orderNumber },
      items: [
        {
          id: 'item-1',
          productSku: 'HHO-200ML',
          lineTotal: 90000,
        },
      ],
    };

    mockPrisma.invoice.findUnique.mockResolvedValueOnce(issuedInvoice);
    mockPrisma.invoice.update.mockImplementationOnce(({ data }: any) => ({
      ...issuedInvoice,
      ...data,
    }));

    const cancelled = await invoiceService.cancelInvoice(
      'inv-to-cancel',
      'Customer requested cancellation before shipment',
      adminUser,
    );

    expect(cancelled.status).toBe(InvoiceStatus.CANCELLED);
    expect(cancelled.cancelReason).toBe('Customer requested cancellation before shipment');
    expect(cancelled.cancelledAt).toBeDefined();

    // Verify financial snapshot remained 100% unchanged!
    expect(cancelled.subtotal).toBe(90000);
    expect(cancelled.grandTotal).toBe(90000);
    expect(cancelled.discountTotal).toBe(0);
    expect(cancelled.shippingTotal).toBe(0);

    // Verify audit event
    expect(mockAuditService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.INVOICE_CANCELLED,
        entityType: AuditEntityType.INVOICE,
        entityId: 'inv-to-cancel',
        orderId: mockOrder.id,
        amount: 90000,
        reason: 'Customer requested cancellation before shipment',
      }),
    );
  });

  it('P2. rejects cancellation of an already CANCELLED invoice', async () => {
    const alreadyCancelledInvoice = {
      id: 'inv-already-cancelled',
      invoiceNumber: 'VN-INV-202609-ALREADY',
      orderId: mockOrder.id,
      userId: testUser.id,
      status: InvoiceStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelReason: 'Prior cancellation',
      order: { orderNumber: mockOrder.orderNumber },
      items: [],
    };

    mockPrisma.invoice.findUnique.mockResolvedValueOnce(alreadyCancelledInvoice);

    await expect(
      invoiceService.cancelInvoice('inv-already-cancelled', 'New reason', adminUser),
    ).rejects.toThrow(BadRequestException);
  });
});
