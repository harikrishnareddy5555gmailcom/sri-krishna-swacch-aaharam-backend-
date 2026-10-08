import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Optional,
  Inject,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service.js';
import { PaymentStatus, CheckoutStatus, OrderStatus, Prisma } from '@prisma/client';
import { AuditAction, AuditEntityType, NotificationEventType } from '@vishkaraa/types';
import { OrderFinalizationError } from './order-finalization.error.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { InvoiceService, type PrismaOrderWithItems as InvoiceOrderWithItems } from '../invoices/invoices.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { FinanceService } from '../finance/finance.service.js';
import type { MinimalUser } from '../permissions/permissions.service.js';
import type {
  OrderDto,
  OrderItemDto,
  OrderShippingAddress,
  OrderListDto,
  AdminOrderListDto,
  AdminOrderDetailDto,
  AdminOrderPaymentSummary,
  AdminOrderAuditItemDto,
  OrderStatus as TypesOrderStatus,
} from '@vishkaraa/types';
import type { AdminOrderListQuery } from './dto/order-query.dto.js';
import type { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';

// =============================================================================
// SYSTEM ACTOR
// =============================================================================
// Sentinel actor ID used for system-initiated audit records.
// Must exist as a user in the database for FK integrity. In production this
// is a dedicated service-account user. In development/test, use the sentinel
// value below and ensure the actor FK on AuditLog is set correctly.
// NOTE: AuditLog.actorId has a RESTRICT FK → users.id.
// For ORDER_FINALIZED we write the audit inside the tx using the ordering user's
// ID as the actor (the user who owns the checkout and payment attempt).
// This avoids the need for a SYSTEM_ACTOR user row in the DB.
// =============================================================================

// Maximum retries for order number generation collisions (P2002 on orderNumber)
const MAX_ORDER_NUMBER_RETRIES = 3;

// =============================================================================
// ORDER NUMBER GENERATION
// =============================================================================

/**
 * Generates an order number in the format: VN-YYYYMM-XXXXXXXX
 * where XXXXXXXX is an 8-character uppercase hex fragment from a random UUID.
 *
 * Collisions are theoretically possible. PostgreSQL UNIQUE constraint is the
 * authoritative guard. P2002 on orderNumber triggers a bounded retry (max 3).
 */
function generateOrderNumber(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const fragment = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `VN-${yyyy}${mm}-${fragment}`;
}

// =============================================================================
// ORDER ITEM PROJECTION
// =============================================================================

type PrismaOrderWithItems = Prisma.OrderGetPayload<{
  include: {
    items: true;
    paymentAttempt: true;
  };
}>;

type PaymentAttemptWithSessionAndItems = Prisma.PaymentAttemptGetPayload<{
  include: {
    checkoutSession: {
      include: { items: true };
    };
  };
}>;

type CheckoutSessionWithItems = Prisma.CheckoutSessionGetPayload<{
  include: { items: true };
}>;

type CheckoutItemSnapshot = Prisma.CheckoutItemSnapshotGetPayload<Record<string, never>>;

function mapOrderToDto(order: PrismaOrderWithItems): OrderDto {
  const shipping: OrderShippingAddress = {
    name:       order.shippingName       ?? null,
    phone:      order.shippingPhone      ?? null,
    line1:      order.shippingLine1      ?? null,
    line2:      order.shippingLine2      ?? null,
    city:       order.shippingCity       ?? null,
    state:      order.shippingState      ?? null,
    postalCode: order.shippingPostalCode ?? null,
    country:    order.shippingCountry    ?? null,
  };

  const items: OrderItemDto[] = order.items.map((item) => ({
    id:              item.id,
    orderId:         item.orderId,
    productId:       item.productId,
    variantId:       item.variantId,
    productName:     item.productName,
    variantName:     item.variantName,
    productSku:      item.productSku,
    primaryImageUrl: item.primaryImageUrl,
    quantity:        item.quantity,
    unitPrice:       item.unitPrice,
    lineTotal:       item.lineTotal,
    currency:        item.currency,
    createdAt:       item.createdAt.toISOString(),
  }));

  return {
    id:                order.id,
    orderNumber:       order.orderNumber,
    userId:            order.userId,
    checkoutSessionId: order.checkoutSessionId,
    paymentAttemptId:  order.paymentAttemptId,
    status:            order.status as unknown as TypesOrderStatus,
    subtotal:          order.subtotal,
    tax:               order.tax,
    discount:          order.discount,
    totalAmount:       order.totalAmount,
    currency:          order.currency,
    shipping,
    items,
    confirmedAt:       order.confirmedAt?.toISOString()  ?? null,
    cancelledAt:       order.cancelledAt?.toISOString()  ?? null,
    deliveredAt:       order.deliveredAt?.toISOString()  ?? null,
    cancellationRequestedAt: order.cancellationRequestedAt?.toISOString() ?? null,
    cancellationReason:      order.cancellationReason ?? null,
    cancellationApprovedAt:  order.cancellationApprovedAt?.toISOString() ?? null,
    cancellationRejectedAt:  order.cancellationRejectedAt?.toISOString() ?? null,
    cancellationAdminNotes:  order.cancellationAdminNotes ?? null,
    notes:             order.notes,
    payment:           order.paymentAttempt ? {
      status:   order.paymentAttempt.status,
      amount:   order.paymentAttempt.amount,
      currency: order.paymentAttempt.currency,
      paidAt:   order.paymentAttempt.updatedAt ? order.paymentAttempt.updatedAt.toISOString() : null,
    } : null,
    createdAt:         order.createdAt.toISOString(),
    updatedAt:         order.updatedAt.toISOString(),
  };
}

// =============================================================================
// ORDER SERVICE
// =============================================================================

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(InventoryService) private readonly inventoryService?: InventoryService,
    @Optional() @Inject(InvoiceService) private readonly invoiceService?: InvoiceService,
    @Optional() @Inject(NotificationService) private readonly notificationService?: NotificationService,
    @Optional() @Inject(FinanceService) private readonly financeService?: FinanceService,
  ) {}

  // ---------------------------------------------------------------------------
  // finalizeFromPayment
  // ---------------------------------------------------------------------------
  /**
   * Converts one authoritative CAPTURED PaymentAttempt into exactly one Order.
   *
   * Algorithm (§6 of Phase 08A design):
   *   Step 1 — Idempotency fast path (outside tx)
   *   Step 2 — Load & validate PaymentAttempt (outside tx)
   *   Step 3 — Load snapshot & compute totals (outside tx)
   *   Step 4 — Integrity assertions (before any write)
   *   Step 5 — Generate order number (outside tx)
   *   Step 6 — Atomic database transaction
   *   Step 7 — Concurrency collision handling
   *
   * @throws {OrderFinalizationError} on any validation or integrity failure.
   */
  async finalizeFromPayment(paymentAttemptId: string): Promise<OrderDto> {
    // ─── STEP 1: Idempotency Fast Path ────────────────────────────────────────
    const existingOrder = await this.prisma.order.findUnique({
      where: { paymentAttemptId },
      include: { items: true, paymentAttempt: true },
    });
    if (existingOrder) {
      this.logger.log(
        `[ORDER] Idempotency hit: order ${existingOrder.orderNumber} already exists for attempt ${paymentAttemptId}`,
      );
      return mapOrderToDto(existingOrder);
    }

    // ─── STEP 2: Load & Validate PaymentAttempt ───────────────────────────────
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { id: paymentAttemptId },
      include: {
        checkoutSession: {
          include: { items: true },
        },
      },
    });

    if (!attempt) {
      throw new OrderFinalizationError('ATTEMPT_NOT_FOUND', `PaymentAttempt not found: ${paymentAttemptId}`);
    }

    if (attempt.status !== PaymentStatus.CAPTURED) {
      throw new OrderFinalizationError(
        'ATTEMPT_NOT_CAPTURED',
        `PaymentAttempt ${paymentAttemptId} status is ${attempt.status}, expected CAPTURED`,
        { status: attempt.status },
      );
    }

    // ─── STEP 3: Load Snapshot & Compute Totals ───────────────────────────────
    const session = attempt.checkoutSession;
    const items   = session.items;

    if (items.length === 0) {
      throw new OrderFinalizationError(
        'EMPTY_SNAPSHOT',
        `CheckoutSession ${session.id} has no item snapshots`,
      );
    }

    const computedSubtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
    const computedTotal    = computedSubtotal; // tax=0, discount=0 in Phase 08

    // ─── STEP 4: Integrity Assertions ─────────────────────────────────────────
    if (attempt.amount !== computedTotal) {
      throw new OrderFinalizationError(
        'AMOUNT_MISMATCH',
        `PaymentAttempt.amount (${attempt.amount}) does not match computed total (${computedTotal})`,
        { attemptAmount: attempt.amount, computedTotal },
      );
    }

    if (attempt.currency !== session.currency) {
      throw new OrderFinalizationError(
        'CURRENCY_MISMATCH',
        `PaymentAttempt.currency (${attempt.currency}) does not match session.currency (${session.currency})`,
        { attemptCurrency: attempt.currency, sessionCurrency: session.currency },
      );
    }

    for (const item of items) {
      if (item.lineTotal !== item.quantity * item.unitPrice) {
        throw new OrderFinalizationError(
          'LINEITEM_INTEGRITY',
          `CheckoutItemSnapshot ${item.id}: lineTotal ${item.lineTotal} ≠ ${item.quantity} × ${item.unitPrice}`,
          { snapshotId: item.id, lineTotal: item.lineTotal, quantity: item.quantity, unitPrice: item.unitPrice },
        );
      }
    }

    // ─── STEP 5 & 6: Generate Number & Atomic Transaction ─────────────────────
    return this.attemptFinalization(
      attempt,
      session,
      items,
      computedSubtotal,
      computedTotal,
      0, // retry counter
    );
  }

  // ---------------------------------------------------------------------------
  // Private: attemptFinalization (bounded retry on orderNumber collision)
  // ---------------------------------------------------------------------------

  private async attemptFinalization(
    attempt: PaymentAttemptWithSessionAndItems,
    session: CheckoutSessionWithItems,
    items: CheckoutItemSnapshot[],
    computedSubtotal: number,
    computedTotal: number,
    retryCount: number,
  ): Promise<OrderDto> {
    const orderNumber = generateOrderNumber();

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // ─── (a) Create Order ────────────────────────────────────────────────
        const now = new Date();
        const order = await tx.order.create({
          data: {
            orderNumber,
            userId:            attempt.userId,
            checkoutSessionId: session.id,
            paymentAttemptId:  attempt.id,
            status:            OrderStatus.CONFIRMED,
            confirmedAt:       now,
            subtotal:          computedSubtotal,
            tax:               0,
            discount:          0,
            totalAmount:       computedTotal,
            currency:          attempt.currency,
            // Shipping address snapshot — copied from CheckoutSession
            shippingName:       session.shippingName       ?? null,
            shippingPhone:      session.shippingPhone      ?? null,
            shippingLine1:      session.shippingLine1      ?? null,
            shippingLine2:      session.shippingLine2      ?? null,
            shippingCity:       session.shippingCity       ?? null,
            shippingState:      session.shippingState      ?? null,
            shippingPostalCode: session.shippingPostalCode ?? null,
            shippingCountry:    session.shippingCountry    ?? null,
          },
        });

        // ─── (b) Create OrderItems (batch insert) ────────────────────────────
        await tx.orderItem.createMany({
          data: items.map((item: CheckoutItemSnapshot) => ({
            orderId:        order.id,
            productId:      item.productId,
            variantId:      item.productVariantId,
            productName:    item.productName,
            variantName:    item.variantName,
            productSku:     item.productSku,
            primaryImageUrl: item.primaryImageUrl,
            quantity:       item.quantity,
            unitPrice:      item.unitPrice,
            lineTotal:      item.lineTotal,
            currency:       item.currency,
          })),
        });

        // ─── (c) Mark CheckoutSession COMPLETED ──────────────────────────────
        // Guard: only update if still ACTIVE. Do not overwrite EXPIRED/CANCELLED.
        await tx.checkoutSession.updateMany({
          where: { id: session.id, status: CheckoutStatus.ACTIVE },
          data:  { status: CheckoutStatus.COMPLETED },
        });

        // ─── (c2) Clean up purchased items from the active cart ─────────────
        // Phase 20D.8.1: Transactional cart cleanup.
        // Removes ONLY the items and quantities that were purchased in this checkout session.
        // Any items added subsequently or unrelated to this checkout session remain preserved in the cart.
        if (session.cartId && tx.cartItem) {
          const purchasedVariantQuantities = new Map<string, number>();
          for (const item of items) {
            const current = purchasedVariantQuantities.get(item.productVariantId) ?? 0;
            purchasedVariantQuantities.set(item.productVariantId, current + item.quantity);
          }

          for (const [variantId, purchasedQty] of purchasedVariantQuantities.entries()) {
            const cartItem = await tx.cartItem.findUnique({
              where: {
                cartId_productVariantId: {
                  cartId: session.cartId,
                  productVariantId: variantId,
                },
              },
            });

            if (cartItem) {
              if (cartItem.quantity > purchasedQty) {
                await tx.cartItem.update({
                  where: { id: cartItem.id },
                  data: { quantity: cartItem.quantity - purchasedQty },
                });
              } else {
                await tx.cartItem.delete({
                  where: { id: cartItem.id },
                });
              }
            }
          }
        }

        // ─── (d) Commit stock reservations in the SAME atomic transaction ─────
        if (this.inventoryService) {
          await this.inventoryService.commitReservation(
            session.id,
            order.id,
            attempt.userId,
            tx,
          );
        }

        // ─── (e) Create invoice in the SAME atomic transaction (Stage 12C) ────
        if (this.invoiceService) {
          const orderItems = await tx.orderItem.findMany({
            where: { orderId: order.id },
          });
          const orderWithItems: InvoiceOrderWithItems = {
            ...order,
            items: orderItems,
          };
          await this.invoiceService.createInvoiceInTransaction(
            orderWithItems,
            tx,
            attempt.userId,
          );
        }

        // ─── (e2) Post financial sale in the SAME atomic transaction (Phase 15B) ─
        if (this.financeService) {
          await this.financeService.postOrderSaleInTransaction(
            {
              id: order.id,
              totalAmount: order.totalAmount,
              subtotal: order.subtotal,
              tax: order.tax,
              currency: order.currency,
            },
            tx,
            attempt.userId,
          );
        }

        // ─── (f) Write mandatory ORDER_FINALIZED audit record ─────────────────
        // MANDATORY: inside transaction. If this fails, the entire tx rolls back.
        // We use the ordering user's ID as actor (avoids needing a SYSTEM user row).
        await tx.auditLog.create({
          data: {
            actorId:       attempt.userId,
            actorRole:     'SYSTEM',
            action:        AuditAction.ORDER_FINALIZED,
            entityType:    AuditEntityType.ORDER,
            entityId:      order.id,
            orderId:       order.id,
            amount:        order.totalAmount,
            currency:      order.currency,
            correlationId: attempt.id,  // paymentAttemptId as trace key
            newValue:      JSON.stringify({
              status:      'CONFIRMED',
              orderNumber: order.orderNumber,
              totalAmount: order.totalAmount,
              currency:    order.currency,
            }),
            reason:    'PaymentAttempt CAPTURED',
            metadata:  JSON.stringify({
              checkoutSessionId: session.id,
              paymentAttemptId:  attempt.id,
              itemCount:         items.length,
            }) as unknown as Prisma.InputJsonObject,
          },
        });

        // ─── (g) In-App Notifications in the SAME atomic transaction ─────────
        if (this.notificationService) {
          // 1. ORDER_CONFIRMED in-app notification
          await this.notificationService.createInAppNotification({
            userId: attempt.userId,
            eventType: NotificationEventType.ORDER_CONFIRMED,
            entityType: 'order',
            entityId: order.id,
            context: {
              customerName: session.shippingName || 'Valued Customer',
              orderNumber: order.orderNumber,
              totalAmount: (order.totalAmount / 100).toFixed(2),
              actionUrl: `/orders/${order.id}`,
            },
            actionUrl: `/orders/${order.id}`,
            metadata: { orderNumber: order.orderNumber },
          }, tx);

          // 2. PAYMENT_CAPTURED in-app notification
          await this.notificationService.createInAppNotification({
            userId: attempt.userId,
            eventType: NotificationEventType.PAYMENT_CAPTURED,
            entityType: 'payment',
            entityId: attempt.id,
            context: {
              customerName: session.shippingName || 'Valued Customer',
              orderNumber: order.orderNumber,
              amount: (order.totalAmount / 100).toFixed(2),
              paymentMethod: attempt.provider || 'Online Payment',
            },
            actionUrl: `/orders/${order.id}`,
            metadata: { orderNumber: order.orderNumber, paymentAttemptId: attempt.id },
          }, tx);

          // 3. ADMIN_NEW_ORDER in-app notification for all SUPER_ADMIN and ADMIN users
          const adminUsers = await tx.user.findMany({
            where: {
              role: { in: ['SUPER_ADMIN', 'ADMIN'] },
              status: 'ACTIVE',
            },
            select: { id: true },
          });

          for (const admin of adminUsers) {
            await this.notificationService.createInAppNotification({
              userId: admin.id,
              eventType: 'ADMIN_NEW_ORDER' as any,
              entityType: 'order',
              entityId: `${order.id}:${admin.id}`,
              context: {
                orderNumber: order.orderNumber,
                customerName: session.shippingName || 'Customer',
                totalAmount: (order.totalAmount / 100).toFixed(2),
                orderTime: new Date().toLocaleTimeString(),
                actionUrl: `/admin/orders/${order.id}`,
              },
              actionUrl: `/admin/orders/${order.id}`,
              metadata: { orderNumber: order.orderNumber, customerId: attempt.userId },
            }, tx);
          }
        }

        return order.id;
      });

      // Reload the full order with items for the response DTO
      const finalOrder = await this.prisma.order.findUniqueOrThrow({
        where: { id: result },
        include: { items: true, paymentAttempt: true },
      });

      this.logger.log(
        `[ORDER] Finalized: ${finalOrder.orderNumber} (orderId=${finalOrder.id}, attemptId=${attempt.id})`,
      );

      return mapOrderToDto(finalOrder);

    } catch (error) {
      // ─── STEP 7: Concurrency Collision Handling ──────────────────────────────
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = error.meta?.['target'] as string[] | undefined;
        const targetStr = JSON.stringify(error.meta?.target || '');

        // Race on paymentAttemptId or invoice orderId: another concurrent request won — idempotent return
        if (
          target?.includes('payment_attempt_id') ||
          target?.includes('paymentAttemptId') ||
          targetStr.includes('payment_attempt_id') ||
          targetStr.includes('paymentAttemptId') ||
          targetStr.includes('order_id') ||
          targetStr.includes('orderId')
        ) {
          this.logger.log(
            `[ORDER] Concurrent finalization race resolved idempotently for attempt ${attempt.id}`,
          );
          const existing = await this.prisma.order.findUnique({
            where: { paymentAttemptId: attempt.id },
            include: { items: true, paymentAttempt: true },
          });
          if (existing) return mapOrderToDto(existing);
        }

        // Collision on orderNumber or invoiceNumber: retry with new UUID fragment
        if (
          target?.includes('order_number') ||
          target?.includes('orderNumber') ||
          targetStr.includes('order_number') ||
          targetStr.includes('orderNumber') ||
          targetStr.includes('invoice_number') ||
          targetStr.includes('invoiceNumber')
        ) {
          if (retryCount >= MAX_ORDER_NUMBER_RETRIES) {
            throw new OrderFinalizationError(
              'ORDER_NUMBER_EXHAUSTED',
              `Failed to generate a unique order or invoice number after ${MAX_ORDER_NUMBER_RETRIES + 1} attempts`,
            );
          }
          this.logger.warn(
            `[ORDER] Order/invoice number collision on attempt #${retryCount + 1} — retrying`,
          );
          return this.attemptFinalization(attempt, session, items, computedSubtotal, computedTotal, retryCount + 1);
        }
      }

      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // getOrderById — ownership-guarded single order retrieval
  // ---------------------------------------------------------------------------

  async getOrderById(orderId: string, userId: string): Promise<OrderDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, paymentAttempt: true },
    });

    if (!order) {
      const { NotFoundException } = await import('@nestjs/common');
      throw new NotFoundException('Order not found');
    }

    if (order.userId !== userId) {
      const { ForbiddenException } = await import('@nestjs/common');
      throw new ForbiddenException('Access denied to this order');
    }

    return mapOrderToDto(order);
  }

  // ---------------------------------------------------------------------------
  // getOrderByNumber — ownership-guarded retrieval by orderNumber
  // ---------------------------------------------------------------------------

  async getOrderByNumber(orderNumber: string, userId: string): Promise<OrderDto> {
    const order = await this.prisma.order.findUnique({
      where: { orderNumber },
      include: { items: true, paymentAttempt: true },
    });

    if (!order) {
      const { NotFoundException } = await import('@nestjs/common');
      throw new NotFoundException('Order not found');
    }

    if (order.userId !== userId) {
      const { ForbiddenException } = await import('@nestjs/common');
      throw new ForbiddenException('Access denied to this order');
    }

    return mapOrderToDto(order);
  }

  // ---------------------------------------------------------------------------
  // getUserOrders — paginated list for the authenticated user
  // ---------------------------------------------------------------------------

  async getUserOrders(
    userId: string,
    page: number = 1,
    limit: number = 20,
    status?: TypesOrderStatus,
  ): Promise<OrderListDto> {
    const safePage = Math.max(page, 1);
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.OrderWhereInput = {
      userId,
      ...(status ? { status } : {}),
    };

    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: { items: true, paymentAttempt: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      orders: orders.map(mapOrderToDto),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  // ---------------------------------------------------------------------------
  // adminGetOrders — paginated list for store administrators
  // ---------------------------------------------------------------------------

  async adminGetOrders(query: AdminOrderListQuery): Promise<AdminOrderListDto> {
    const page = Math.max(query.page || 1, 1);
    const limit = Math.min(Math.max(query.limit || 20, 1), 100);
    const skip = (page - 1) * limit;

    const where: Prisma.OrderWhereInput = {};
    if (query.status) {
      where.status = query.status;
    }
    if (query.userId) {
      where.userId = query.userId;
    }
    if (query.fromDate || query.toDate) {
      where.createdAt = {};
      if (query.fromDate) {
        where.createdAt.gte = new Date(query.fromDate);
      }
      if (query.toDate) {
        where.createdAt.lte = new Date(query.toDate);
      }
    }
    if (query.search?.trim()) {
      const q = query.search.trim();
      where.OR = [
        { orderNumber: { contains: q, mode: 'insensitive' } },
        { shippingName: { contains: q, mode: 'insensitive' } },
        { shippingPhone: { contains: q, mode: 'insensitive' } },
        { user: { email: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: {
          user: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          _count: {
            select: { items: true },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      orders: rows.map((r) => ({
        id: r.id,
        orderNumber: r.orderNumber,
        userId: r.userId,
        customer: r.user ? {
          id: r.user.id,
          email: r.user.email,
          firstName: r.user.firstName,
          lastName: r.user.lastName,
        } : null,
        status: r.status as unknown as TypesOrderStatus,
        totalAmount: r.totalAmount,
        currency: r.currency,
        itemCount: r._count?.items ?? 0,
        shippingCity: r.shippingCity,
        shippingState: r.shippingState,
        createdAt: r.createdAt.toISOString(),
        confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
        cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
      })),
      total,
      page,
      limit,
    };
  }

  // ---------------------------------------------------------------------------
  // adminGetOrderById — single order with operational details for administrators
  // ---------------------------------------------------------------------------

  async adminGetOrderById(orderId: string): Promise<AdminOrderDetailDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        paymentAttempt: true,
        user: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        auditLogs: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const baseDto = mapOrderToDto(order);

    const operationalPayment: AdminOrderPaymentSummary | null = order.paymentAttempt ? {
      paymentAttemptId: order.paymentAttempt.id,
      checkoutSessionId: order.checkoutSessionId,
      provider: order.paymentAttempt.provider,
      providerOrderId: order.paymentAttempt.providerOrderId,
      providerPaymentId: order.paymentAttempt.providerPaymentId,
      status: order.paymentAttempt.status,
      amount: order.paymentAttempt.amount,
      currency: order.paymentAttempt.currency,
      createdAt: order.paymentAttempt.createdAt.toISOString(),
      updatedAt: order.paymentAttempt.updatedAt.toISOString(),
    } : null;

    const auditTrail: AdminOrderAuditItemDto[] = order.auditLogs.map((a) => ({
      id: a.id,
      action: a.action,
      actorRole: a.actorRole,
      actorEmail: null,
      previousValue: typeof a.previousValue === 'string' ? a.previousValue : JSON.stringify(a.previousValue),
      newValue: typeof a.newValue === 'string' ? a.newValue : JSON.stringify(a.newValue),
      reason: a.reason,
      createdAt: a.createdAt.toISOString(),
    }));

    return {
      ...baseDto,
      customer: order.user ? {
        id: order.user.id,
        email: order.user.email,
        firstName: order.user.firstName,
        lastName: order.user.lastName,
      } : null,
      operationalPayment,
      auditTrail,
    };
  }

  // ---------------------------------------------------------------------------
  // updateOrderStatus — administrative state machine transitions
  // ---------------------------------------------------------------------------

  async updateOrderStatus(
    orderId: string,
    actor: MinimalUser,
    input: UpdateOrderStatusDto,
  ): Promise<OrderDto> {
    const targetStatus = input.status as unknown as OrderStatus;

    if (targetStatus === OrderStatus.CANCELLED) {
      const reason = input.reason?.trim();
      if (!reason || reason.length < 3) {
        throw new BadRequestException(
          'A non-empty cancellation reason (at least 3 characters) is required when cancelling an order',
        );
      }
    }

    return await this.prisma.$transaction(async (tx) => {
      const current = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true, paymentAttempt: true },
      });

      if (!current) {
        throw new NotFoundException('Order not found');
      }

      // Idempotent retry: same status is a safe no-op (no duplicate audit)
      if (current.status === targetStatus) {
        this.logger.log(
          `[ORDER] Idempotent status update: order ${current.orderNumber} is already in status ${targetStatus}`,
        );
        return mapOrderToDto(current);
      }

      // State machine validation
      this.validateTransition(current.status, targetStatus);

      const now = new Date();
      const cancelledAt = targetStatus === OrderStatus.CANCELLED ? now : current.cancelledAt;
      const deliveredAt =
        targetStatus === OrderStatus.DELIVERED && current.status !== OrderStatus.DELIVERED
          ? now
          : current.deliveredAt;
      const notes = input.notes?.trim() ? input.notes.trim() : current.notes;

      // Atomic conditional update
      const updateResult = await tx.order.updateMany({
        where: {
          id: orderId,
          status: current.status,
        },
        data: {
          status: targetStatus,
          cancelledAt,
          deliveredAt,
          notes,
          updatedAt: now,
        },
      });

      if (updateResult.count === 0) {
        const reRead = await tx.order.findUnique({
          where: { id: orderId },
          include: { items: true, paymentAttempt: true },
        });
        if (reRead?.status === targetStatus) {
          return mapOrderToDto(reRead);
        }
        throw new ConflictException(
          'STALE_ORDER_STATUS: Order was concurrently modified by another request',
        );
      }

      // Inventory transition hooks inside the same transaction
      if (this.inventoryService) {
        if (targetStatus === OrderStatus.CANCELLED) {
          await this.inventoryService.restoreCancelledOrder(
            orderId,
            actor.id,
            input.reason?.trim() || 'Operational cancellation',
            tx,
          );
        } else if (targetStatus === OrderStatus.SHIPPED) {
          await this.inventoryService.shipOrderInventory(
            orderId,
            actor.id,
            tx,
          );
        }
      }

      // Mandatory AuditLog in same transaction
      const auditAction = targetStatus === OrderStatus.CANCELLED
        ? AuditAction.ORDER_CANCELLED
        : AuditAction.ORDER_STATUS_CHANGED_ADMIN;

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: auditAction,
          entityType: AuditEntityType.ORDER,
          entityId: orderId,
          orderId: orderId,
          amount: current.totalAmount,
          currency: current.currency,
          correlationId: current.paymentAttemptId,
          previousValue: JSON.stringify({ status: current.status }),
          newValue: JSON.stringify({
            status: targetStatus,
            cancelledAt: cancelledAt ? cancelledAt.toISOString() : null,
          }),
          reason: input.reason?.trim() || (targetStatus === OrderStatus.CANCELLED ? 'Operational cancellation' : `Status updated to ${targetStatus}`),
          metadata: {
            orderNumber: current.orderNumber,
            notes: input.notes?.trim() || null,
            refundStatus: targetStatus === OrderStatus.CANCELLED ? 'NO_REFUND_IN_PHASE_08' : null,
          },
        },
      });

      // In-App Notification inside the same transaction
      if (this.notificationService && targetStatus === OrderStatus.CANCELLED) {
        await this.notificationService.createInAppNotification({
          userId: current.userId,
          eventType: NotificationEventType.ORDER_CANCELLED,
          entityType: 'order',
          entityId: current.id,
          context: {
            customerName: current.shippingName || 'Customer',
            orderNumber: current.orderNumber,
            totalAmount: (current.totalAmount / 100).toFixed(2),
            actionUrl: `/orders/${current.id}`,
          },
          actionUrl: `/orders/${current.id}`,
          metadata: { orderNumber: current.orderNumber, cancelReason: notes },
        }, tx);
      }

      const finalOrder = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true, paymentAttempt: true },
      });

      this.logger.log(
        `[ORDER] Status changed for ${finalOrder.orderNumber}: ${current.status} -> ${targetStatus} by actor ${actor.id} (${actor.role})`,
      );

      return mapOrderToDto(finalOrder);
    });
  }

  private validateTransition(currentStatus: OrderStatus, targetStatus: OrderStatus): void {
    if (currentStatus === targetStatus) return;

    if (currentStatus === OrderStatus.DELIVERED) {
      throw new ConflictException('ORDER_ALREADY_DELIVERED: Order is delivered and in terminal state');
    }
    if (currentStatus === OrderStatus.CANCELLED) {
      throw new ConflictException('ORDER_ALREADY_CANCELLED: Order is cancelled and in terminal state');
    }
    if (currentStatus === OrderStatus.SHIPPED && targetStatus === OrderStatus.CANCELLED) {
      throw new ConflictException('CANNOT_CANCEL_SHIPPED_ORDER: In-transit orders cannot be cancelled');
    }

    const isAllowed =
      (currentStatus === OrderStatus.CONFIRMED && (targetStatus === OrderStatus.PROCESSING || targetStatus === OrderStatus.CANCELLED)) ||
      (currentStatus === OrderStatus.PROCESSING && (targetStatus === OrderStatus.SHIPPED || targetStatus === OrderStatus.CANCELLED)) ||
      (currentStatus === OrderStatus.SHIPPED && targetStatus === OrderStatus.DELIVERED);

    if (!isAllowed) {
      throw new BadRequestException(
        `INVALID_STATUS_TRANSITION: Cannot transition order from ${currentStatus} to ${targetStatus}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Customer Cancellation Request & Admin Review (Phase 20D.5)
  // ---------------------------------------------------------------------------

  /**
   * Customer submits a request to cancel their order.
   * Enforces:
   * 1. Order ownership
   * 2. Cannot cancel if order is already CANCELLED, SHIPPED, or DELIVERED
   * 3. Cannot cancel if shipments are already PACKED, READY_TO_SHIP, SHIPPED, or in-transit
   * 4. Idempotency (prevents duplicate pending requests)
   */
  async requestOrderCancellation(
    orderId: string,
    userId: string,
    reason: string,
  ): Promise<OrderDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        shipments: true,
        items: true,
        paymentAttempt: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.userId !== userId) {
      throw new ForbiddenException('You are not authorized to cancel this order');
    }

    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException('This order is already cancelled.');
    }

    if (order.status === OrderStatus.DELIVERED) {
      throw new BadRequestException('Delivered orders cannot be cancelled. You may submit a return or damage report instead.');
    }

    if (order.status === OrderStatus.SHIPPED) {
      throw new BadRequestException('This order has already been shipped and cannot be cancelled.');
    }

    // Check shipments: cannot cancel if packed, ready to ship, or dispatched
    const nonCancellableShipment = order.shipments?.some((s) =>
      ['PACKED', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(s.status),
    );

    if (nonCancellableShipment) {
      throw new BadRequestException(
        'Cancellation is unavailable because your order is already packed or in fulfillment dispatch.',
      );
    }

    if (order.cancellationRequestedAt && !order.cancellationRejectedAt) {
      throw new BadRequestException(
        'A cancellation request for this order is already pending administrator review.',
      );
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        cancellationRequestedAt: new Date(),
        cancellationReason: reason.trim(),
        cancellationApprovedAt: null,
        cancellationRejectedAt: null,
        cancellationAdminNotes: null,
      },
      include: {
        items: true,
        paymentAttempt: true,
      },
    });

    // Audit log
    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        actorRole: 'USER',
        action: AuditAction.ORDER_STATUS_CHANGED,
        entityType: AuditEntityType.ORDER,
        entityId: orderId,
        orderId,
        reason: `Customer cancellation requested: ${reason.trim()}`,
      },
    });

    // Notify Admins of pending cancellation request
    if (this.notificationService) {
      const adminUsers = await this.prisma.user.findMany({
        where: {
          role: { in: ['SUPER_ADMIN', 'ADMIN'] },
          status: 'ACTIVE',
        },
        select: { id: true },
      });

      for (const admin of adminUsers) {
        await this.notificationService.createInAppNotification({
          userId: admin.id,
          eventType: 'ADMIN_NEW_ORDER' as any, // Using existing operational type
          entityType: 'order',
          entityId: order.id,
          context: {
            orderNumber: order.orderNumber,
            customerName: order.shippingName || 'Customer',
            totalAmount: (order.totalAmount / 100).toFixed(2),
            orderTime: `Cancellation Requested: ${reason.slice(0, 30)}`,
            actionUrl: `/admin/orders/${order.id}`,
          },
          actionUrl: `/admin/orders/${order.id}`,
          metadata: { orderNumber: order.orderNumber, cancellationRequest: true },
        }).catch(() => {});
      }
    }

    return mapOrderToDto(updated);
  }

  /**
   * Admin approves or rejects a customer's cancellation request.
   */
  async reviewOrderCancellation(
    orderId: string,
    actor: MinimalUser,
    approved: boolean,
    notes?: string,
  ): Promise<OrderDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        paymentAttempt: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (!order.cancellationRequestedAt) {
      throw new BadRequestException('No cancellation request is pending for this order.');
    }

    if (approved) {
      // 1. Cancel the order atomically using standard updateOrderStatus
      await this.updateOrderStatus(orderId, actor, {
        status: OrderStatus.CANCELLED as unknown as TypesOrderStatus,
        reason: order.cancellationReason || 'Customer cancellation request approved by admin',
        notes: notes?.trim() || 'Cancellation approved',
      });

      // 2. Mark approval timestamp
      const finalOrder = await this.prisma.order.update({
        where: { id: orderId },
        data: {
          cancellationApprovedAt: new Date(),
          cancellationAdminNotes: notes?.trim() ?? null,
        },
        include: {
          items: true,
          paymentAttempt: true,
        },
      });

      // 3. Notify customer
      if (this.notificationService) {
        await this.notificationService.createInAppNotification({
          userId: order.userId,
          eventType: NotificationEventType.ORDER_CANCELLED,
          entityType: 'order',
          entityId: order.id,
          context: {
            customerName: order.shippingName || 'Customer',
            orderNumber: order.orderNumber,
            totalAmount: (order.totalAmount / 100).toFixed(2),
            actionUrl: `/orders/${order.id}`,
          },
          actionUrl: `/orders/${order.id}`,
          metadata: { orderNumber: order.orderNumber, approved: true, notes },
        }).catch(() => {});
      }

      return mapOrderToDto(finalOrder);
    } else {
      // Reject cancellation request
      const finalOrder = await this.prisma.order.update({
        where: { id: orderId },
        data: {
          cancellationRejectedAt: new Date(),
          cancellationAdminNotes: notes?.trim() ?? 'Cancellation request declined',
        },
        include: {
          items: true,
          paymentAttempt: true,
        },
      });

      // Audit log
      await this.prisma.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          actorEmail: actor.email,
          action: AuditAction.ORDER_STATUS_CHANGED,
          entityType: AuditEntityType.ORDER,
          entityId: orderId,
          orderId,
          reason: `Customer cancellation rejected by admin: ${notes || 'No reason provided'}`,
        },
      });

      return mapOrderToDto(finalOrder);
    }
  }
}
