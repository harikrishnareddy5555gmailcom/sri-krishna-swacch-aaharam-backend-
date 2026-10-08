import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  OrderStatus,
  CheckoutStatus,
  PaymentStatus,
  ProductStatus,
  ProductVariantStatus,
  ReservationStatus,
  InvoiceStatus,
} from '@prisma/client';
import { OrderService } from '../src/orders/orders.service.js';
import { InvoiceService } from '../src/invoices/invoices.service.js';
import { InventoryService } from '../src/inventory/inventory.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { PermissionsService } from '../src/permissions/permissions.service.js';
import { AuditAction, AuditEntityType, UserRole } from '@vishkaraa/types';

describe('Phase 12: Stage 12C — Order → Invoice Atomic Integration & Concurrency', () => {
  const testDbUrl =
    process.env['DATABASE_URL_TEST'] ||
    process.env['DATABASE_URL'] ||
    'postgresql://postgres:Hari@950@localhost:5432/vishkaraa_test?schema=public';

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: testDbUrl,
      },
    },
  });

  let inventoryService: InventoryService;
  let invoiceService: InvoiceService;
  let orderService: OrderService;

  let testUserId: string;
  let testProductId: string;
  let testVariantId: string;
  const createdUserIds: string[] = [];
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();

    const auditService = new AuditService(prisma as any);
    const mockPermissionsService = {
      can: async () => true,
    } as unknown as PermissionsService;

    inventoryService = new InventoryService(prisma as any, auditService);
    invoiceService = new InvoiceService(prisma as any, auditService, mockPermissionsService);
    orderService = new OrderService(prisma as any, inventoryService, invoiceService);

    const timestamp = Date.now();

    // 1. Create primary test user
    const user = await prisma.user.create({
      data: {
        email: `stage12c-test-${timestamp}@vishkaraa.local`,
        passwordHash: 'dummy-hash',
        firstName: 'Financial',
        lastName: 'Integration',
        role: 'USER',
      },
    });
    testUserId = user.id;
    createdUserIds.push(user.id);

    // 2. Create Category, Product and Variant
    const category = await prisma.category.create({
      data: {
        name: `Stage 12C Cat ${timestamp}`,
        slug: `stage12c-cat-${timestamp}`,
      },
    });

    const product = await prisma.product.create({
      data: {
        name: 'Cold Pressed Sesame Oil 500ml',
        slug: `sesame-oil-${timestamp}`,
        status: ProductStatus.ACTIVE,
        categoryId: category.id,
      },
    });
    testProductId = product.id;

    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        name: '500ml Bottle',
        sku: `SESAME-500ML-${timestamp}`,
        price: 35000, // 350 INR in paise
        currency: 'INR',
        status: ProductVariantStatus.ACTIVE,
      },
    });
    testVariantId = variant.id;

    // Initialize inventory stock with 100 units
    await inventoryService.ensureInventoryItem(variant.id);
    await prisma.inventoryItem.update({
      where: { variantId: variant.id },
      data: { onHand: 100, reserved: 0, committed: 0 },
    });
  });

  afterAll(async () => {
    try {
      for (const sessId of createdSessionIds) {
        await prisma.invoiceItem.deleteMany({
          where: { invoice: { order: { checkoutSessionId: sessId } } },
        });
        await prisma.invoice.deleteMany({
          where: { order: { checkoutSessionId: sessId } },
        });
        await prisma.orderItem.deleteMany({
          where: { order: { checkoutSessionId: sessId } },
        });
        await prisma.auditLog.deleteMany({
          where: { order: { checkoutSessionId: sessId } },
        });
        await prisma.order.deleteMany({
          where: { checkoutSessionId: sessId },
        });
        await prisma.inventoryReservation.deleteMany({
          where: { checkoutSessionId: sessId },
        });
        await prisma.paymentAttempt.deleteMany({
          where: { checkoutSessionId: sessId },
        });
        await prisma.checkoutItemSnapshot.deleteMany({
          where: { checkoutSessionId: sessId },
        });
        await prisma.checkoutSession.deleteMany({
          where: { id: sessId },
        });
      }

      await prisma.inventoryMovement.deleteMany({
        where: { variantId: testVariantId },
      });
      await prisma.inventoryItem.deleteMany({
        where: { variantId: testVariantId },
      });
      await prisma.productVariant.deleteMany({
        where: { id: testVariantId },
      });
      await prisma.product.deleteMany({
        where: { id: testProductId },
      });
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    } catch {
      // Ignore cleanup error
    } finally {
      await prisma.$disconnect();
    }
  });

  // Helper to create a complete CAPTURED PaymentAttempt ready for finalization
  async function createCapturedAttemptSetup(quantity = 2) {
    const timestamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const lineTotal = quantity * 35000;

    const user = await prisma.user.create({
      data: {
        email: `stage12c-user-${timestamp}@vishkaraa.local`,
        passwordHash: 'dummy-hash',
        firstName: 'Financial',
        lastName: `Customer-${timestamp}`,
        role: 'USER',
      },
    });
    createdUserIds.push(user.id);

    const cart = await prisma.cart.create({
      data: {
        userId: user.id,
        currency: 'INR',
      },
    });

    const session = await prisma.checkoutSession.create({
      data: {
        cartId: cart.id,
        userId: user.id,
        status: CheckoutStatus.ACTIVE,
        currency: 'INR',
        subtotal: lineTotal,
        expiresAt: new Date(Date.now() + 3600000),
        shippingName: 'Hari Raman',
        shippingPhone: '+919876543210',
        shippingLine1: '42 Heritage Boulevard',
        shippingCity: 'Bengaluru',
        shippingState: 'Karnataka',
        shippingPostalCode: '560001',
        shippingCountry: 'IN',
        items: {
          create: [
            {
              productId: testProductId,
              productVariantId: testVariantId,
              productName: 'Cold Pressed Sesame Oil 500ml',
              variantName: '500ml Bottle',
              productSku: `SESAME-500ML-${timestamp}`,
              quantity,
              unitPrice: 35000,
              lineTotal,
              currency: 'INR',
            },
          ],
        },
      },
      include: { items: true },
    });
    createdSessionIds.push(session.id);

    // Reserve stock for the checkout session
    await inventoryService.reserveStock({
      checkoutSessionId: session.id,
      items: [{ variantId: testVariantId, quantity }],
      expiresAt: session.expiresAt,
      actorId: user.id,
    });

    // Create CAPTURED payment attempt
    const attempt = await prisma.paymentAttempt.create({
      data: {
        checkoutSessionId: session.id,
        userId: user.id,
        amount: lineTotal,
        currency: 'INR',
        status: PaymentStatus.CAPTURED,
        provider: 'RAZORPAY',
        providerOrderId: `order_rzp_${timestamp}`,
        providerPaymentId: `pay_rzp_${timestamp}`,
      },
    });

    return { session, attempt, user, lineTotal, quantity };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST A: Two simultaneous finalization attempts for same CAPTURED attempt
  // ───────────────────────────────────────────────────────────────────────────
  it('A. Two simultaneous finalization attempts create exactly 1 Order and 1 Invoice atomically', async () => {
    const { attempt, lineTotal, quantity } = await createCapturedAttemptSetup(2);

    // Concurrently trigger finalization from two simultaneous callers
    const [res1, res2] = await Promise.allSettled([
      orderService.finalizeFromPayment(attempt.id),
      orderService.finalizeFromPayment(attempt.id),
    ]);

    // Both callers must resolve successfully (one winning tx, one idempotent fast/recovery path)
    expect(res1.status).toBe('fulfilled');
    expect(res2.status).toBe('fulfilled');

    const order1 = (res1 as PromiseFulfilledResult<any>).value;
    const order2 = (res2 as PromiseFulfilledResult<any>).value;

    expect(order1.id).toBe(order2.id);
    expect(order1.orderNumber).toBe(order2.orderNumber);
    expect(order1.totalAmount).toBe(lineTotal);
    expect(order1.status).toBe(OrderStatus.CONFIRMED);

    // Database verification: Exactly 1 Order row
    const orders = await prisma.order.findMany({
      where: { paymentAttemptId: attempt.id },
      include: { items: true },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]!.items).toHaveLength(1);
    expect(orders[0]!.items[0]!.quantity).toBe(quantity);

    // Database verification: Exactly 1 Invoice row
    const invoices = await prisma.invoice.findMany({
      where: { orderId: order1.id },
      include: { items: true },
    });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.status).toBe(InvoiceStatus.ISSUED);
    expect(invoices[0]!.grandTotal).toBe(lineTotal);
    expect(invoices[0]!.subtotal).toBe(lineTotal);
    expect(invoices[0]!.items).toHaveLength(1);
    expect(invoices[0]!.items[0]!.quantity).toBe(quantity);
    expect(invoices[0]!.items[0]!.unitPrice).toBe(35000);

    // Database verification: Inventory reservation committed exactly once
    const reservations = await prisma.inventoryReservation.findMany({
      where: { checkoutSessionId: attempt.checkoutSessionId },
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.status).toBe(ReservationStatus.COMMITTED);
    expect(reservations[0]!.orderId).toBe(order1.id);

    // Database verification: Audit logs
    const orderAudits = await prisma.auditLog.findMany({
      where: {
        orderId: order1.id,
        action: AuditAction.ORDER_FINALIZED,
      },
    });
    expect(orderAudits).toHaveLength(1);

    const invoiceAudits = await prisma.auditLog.findMany({
      where: {
        orderId: order1.id,
        action: AuditAction.INVOICE_ISSUED,
      },
    });
    expect(invoiceAudits).toHaveLength(1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST B: Two simultaneous invoice creation attempts for the same finalized Order
  // ───────────────────────────────────────────────────────────────────────────
  it('B. Two simultaneous invoice creation calls for the same Order resolve safely to 1 Invoice', async () => {
    const { attempt } = await createCapturedAttemptSetup(1);

    // First finalize the order with order service
    const finalizedOrder = await orderService.finalizeFromPayment(attempt.id);

    // Now call invoiceService.createInvoiceForOrder concurrently
    const [inv1, inv2] = await Promise.all([
      invoiceService.createInvoiceForOrder(finalizedOrder.id, testUserId),
      invoiceService.createInvoiceForOrder(finalizedOrder.id, testUserId),
    ]);

    expect(inv1.id).toBe(inv2.id);
    expect(inv1.invoiceNumber).toBe(inv2.invoiceNumber);
    expect(inv1.orderId).toBe(finalizedOrder.id);

    // Exactly 1 invoice in database
    const dbInvoices = await prisma.invoice.findMany({
      where: { orderId: finalizedOrder.id },
    });
    expect(dbInvoices).toHaveLength(1);
    expect(dbInvoices[0]!.id).toBe(inv1.id);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST C: Invoice failure rolls back the entire financial transaction
  // ───────────────────────────────────────────────────────────────────────────
  it('C. Invoice creation failure causes all-or-nothing rollback (no Order, no Invoice, no committed inventory)', async () => {
    const { session, attempt } = await createCapturedAttemptSetup(1);

    // Construct an OrderService with a failing InvoiceService
    const failingInvoiceService = {
      createInvoiceInTransaction: async () => {
        throw new Error('Simulated atomic invoice failure');
      },
    } as unknown as InvoiceService;

    const rollbackOrderService = new OrderService(
      prisma as any,
      inventoryService,
      failingInvoiceService,
    );

    // Finalization must fail
    await expect(rollbackOrderService.finalizeFromPayment(attempt.id)).rejects.toThrow(
      'Simulated atomic invoice failure',
    );

    // Database verification: No Order exists
    const order = await prisma.order.findUnique({
      where: { paymentAttemptId: attempt.id },
    });
    expect(order).toBeNull();

    // Database verification: No OrderItems exist
    const orderItems = await prisma.orderItem.findMany({
      where: { productSku: session.items[0]!.productSku },
    });
    expect(orderItems).toHaveLength(0);

    // Database verification: No Invoice exists
    const invoices = await prisma.invoice.findMany({
      where: { userId: testUserId, grandTotal: attempt.amount },
    });
    // None should reference this attempt
    const orphanInvoice = await prisma.invoice.findFirst({
      where: { order: { checkoutSessionId: session.id } },
    });
    expect(orphanInvoice).toBeNull();

    // Database verification: CheckoutSession remains ACTIVE (not COMPLETED)
    const sessionAfter = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(sessionAfter.status).toBe(CheckoutStatus.ACTIVE);

    // Database verification: Inventory reservation remains PENDING (not COMMITTED)
    const reservation = await prisma.inventoryReservation.findFirstOrThrow({
      where: { checkoutSessionId: session.id },
    });
    expect(reservation.status).toBe(ReservationStatus.PENDING);
    expect(reservation.orderId).toBeNull();

    // Database verification: No ORDER_FINALIZED or INVOICE_ISSUED audit logs for this session
    const auditLogs = await prisma.auditLog.findMany({
      where: { correlationId: attempt.id },
    });
    expect(auditLogs).toHaveLength(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST D: Retry after a successful finalization (idempotency fast-path)
  // ───────────────────────────────────────────────────────────────────────────
  it('D. Repeated finalization of a successful PaymentAttempt returns existing Order and Invoice without side effects', async () => {
    const { attempt, lineTotal } = await createCapturedAttemptSetup(1);

    // First finalization
    const initialOrder = await orderService.finalizeFromPayment(attempt.id);
    expect(initialOrder.totalAmount).toBe(lineTotal);

    // Read initial invoice count
    const initialInvoiceCount = await prisma.invoice.count({
      where: { orderId: initialOrder.id },
    });
    expect(initialInvoiceCount).toBe(1);

    const initialAuditCount = await prisma.auditLog.count({
      where: { orderId: initialOrder.id },
    });

    // Second finalization (idempotent retry)
    const retriedOrder = await orderService.finalizeFromPayment(attempt.id);

    expect(retriedOrder.id).toBe(initialOrder.id);
    expect(retriedOrder.orderNumber).toBe(initialOrder.orderNumber);

    // Side effects verification: No duplicates
    const finalOrderCount = await prisma.order.count({
      where: { paymentAttemptId: attempt.id },
    });
    expect(finalOrderCount).toBe(1);

    const finalInvoiceCount = await prisma.invoice.count({
      where: { orderId: initialOrder.id },
    });
    expect(finalInvoiceCount).toBe(1);

    const finalAuditCount = await prisma.auditLog.count({
      where: { orderId: initialOrder.id },
    });
    expect(finalAuditCount).toBe(initialAuditCount);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST E: Ownership & Manual admin issue endpoint invariant guards
  // ───────────────────────────────────────────────────────────────────────────
  it('E. Manual admin issuance respects financial authority and rejects cancelled orders', async () => {
    const { attempt } = await createCapturedAttemptSetup(1);
    const order = await orderService.finalizeFromPayment(attempt.id);

    // Mark order as CANCELLED directly in DB to test guard
    await prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.CANCELLED },
    });

    // Delete existing invoice so we can test createInvoiceForOrder guard
    await prisma.invoiceItem.deleteMany({ where: { invoice: { orderId: order.id } } });
    await prisma.invoice.deleteMany({ where: { orderId: order.id } });

    await expect(
      invoiceService.createInvoiceForOrder(order.id, testUserId),
    ).rejects.toThrow(/Cannot create invoice for cancelled order/);
  });
});
