import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Optional,
  Inject,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PermissionsService, type MinimalUser } from '../permissions/permissions.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import {
  InvoiceStatus,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import {
  AuditAction,
  AuditEntityType,
  Permissions,
  UserRole,
  NotificationEventType,
  InvoiceStatus as TypesInvoiceStatus,
  type InvoiceDto,
  type InvoiceItemDto,
  type AdminInvoiceListQueryDto,
} from '@vishkaraa/types';

// =============================================================================
// DEFAULT SELLER BUSINESS SNAPSHOT
// =============================================================================
export const DEFAULT_SELLER_SNAPSHOT = {
  sellerName: 'Sri Krishna Swacch Aaharam',
  sellerAddressLine1: 'Opp to ICICI Bank',
  sellerAddressLine2: 'Macherla',
  sellerCity: 'Macherla',
  sellerState: 'Andhra Pradesh',
  sellerPostalCode: '',
  sellerCountry: 'IN',
  sellerEmail: '',
  sellerPhone: '9491337723',
  sellerGstin: null,
};

const MAX_INVOICE_NUMBER_RETRIES = 3;

/**
 * Generates an invoice number in the format: VN-INV-YYYYMM-XXXXXXXX
 * where XXXXXXXX is an 8-character uppercase hex fragment from a random UUID.
 *
 * Concurrency-safe and protected by PostgreSQL UNIQUE constraint.
 */
export function generateInvoiceNumber(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const fragment = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `VN-INV-${yyyy}${mm}-${fragment}`;
}

// Prisma payload types
export type PrismaInvoiceWithItemsAndOrder = Prisma.InvoiceGetPayload<{
  include: {
    items: true;
    order: {
      select: {
        orderNumber: true;
      };
    };
  };
}>;

export type PrismaOrderWithItems = Prisma.OrderGetPayload<{
  include: {
    items: true;
  };
}>;

export function mapInvoiceToDto(invoice: PrismaInvoiceWithItemsAndOrder): InvoiceDto {
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    orderId: invoice.orderId,
    orderNumber: invoice.order?.orderNumber,
    userId: invoice.userId,
    status: invoice.status as TypesInvoiceStatus,
    currency: invoice.currency,
    subtotal: invoice.subtotal,
    discountTotal: invoice.discountTotal,
    shippingTotal: invoice.shippingTotal,
    taxTotal: invoice.taxTotal,
    grandTotal: invoice.grandTotal,

    billingName: invoice.billingName,
    billingPhone: invoice.billingPhone,
    billingLine1: invoice.billingLine1,
    billingLine2: invoice.billingLine2,
    billingCity: invoice.billingCity,
    billingState: invoice.billingState,
    billingPostalCode: invoice.billingPostalCode,
    billingCountry: invoice.billingCountry,
    billingAddress: invoice.billingSnapshot as Record<string, unknown> | null,

    sellerName: invoice.sellerName,
    sellerAddressLine1: invoice.sellerAddressLine1,
    sellerAddressLine2: invoice.sellerAddressLine2,
    sellerCity: invoice.sellerCity,
    sellerState: invoice.sellerState,
    sellerPostalCode: invoice.sellerPostalCode,
    sellerCountry: invoice.sellerCountry,
    sellerEmail: invoice.sellerEmail,
    sellerPhone: invoice.sellerPhone,
    sellerGstin: invoice.sellerGstin,
    sellerSnapshot: invoice.sellerSnapshot as Record<string, unknown> | null,

    customerGstin: invoice.customerGstin,
    placeOfSupply: invoice.placeOfSupply,
    isReverseCharge: invoice.isReverseCharge,
    invoiceType: invoice.invoiceType,

    issuedAt: invoice.issuedAt.toISOString(),
    cancelledAt: invoice.cancelledAt?.toISOString() ?? null,
    cancelReason: invoice.cancelReason,
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),

    items: invoice.items?.map((item): InvoiceItemDto => ({
      id: item.id,
      invoiceId: item.invoiceId,
      orderItemId: item.orderItemId,
      productId: item.productId,
      variantId: item.variantId,
      productName: item.productName,
      variantName: item.variantName,
      productSku: item.productSku,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountAmount: item.discountAmount,
      taxableAmount: item.taxableAmount,
      taxAmount: item.taxAmount,
      lineTotal: item.lineTotal,
      currency: item.currency,
      hsnSac: item.hsnSac,
      taxRate: item.taxRate ?? undefined,
      cgstAmount: item.cgstAmount ?? undefined,
      sgstAmount: item.sgstAmount ?? undefined,
      igstAmount: item.igstAmount ?? undefined,
      cessAmount: item.cessAmount ?? undefined,
      createdAt: item.createdAt ? item.createdAt.toISOString() : new Date().toISOString(),
    })),
  };
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly permissionsService: PermissionsService,
    @Optional() @Inject(NotificationService) private readonly notificationService?: NotificationService,
  ) {}

  // ===========================================================================
  // INVOICE CREATION
  // ===========================================================================

  /**
   * Generates a finalized Invoice for an existing confirmed Order.
   * Fully idempotent: returns existing invoice if already generated.
   */
  async createInvoiceForOrder(orderId: string, actorId?: string): Promise<InvoiceDto> {
    // 1. Idempotency fast path: return existing invoice if already created
    const existing = await this.prisma.invoice.findUnique({
      where: { orderId },
      include: {
        items: true,
        order: { select: { orderNumber: true } },
      },
    });

    if (existing) {
      this.logger.log(
        `[INVOICE] Idempotency hit: invoice ${existing.invoiceNumber} already exists for order ${orderId}`,
      );
      return mapInvoiceToDto(existing);
    }

    // 2. Fetch authoritative Order and items
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    // 3. Finalization status guard
    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException(
        `Cannot create invoice for cancelled order ${order.orderNumber}`,
      );
    }

    if (
      order.status !== OrderStatus.CONFIRMED &&
      order.status !== OrderStatus.PROCESSING &&
      order.status !== OrderStatus.SHIPPED &&
      order.status !== OrderStatus.DELIVERED
    ) {
      throw new BadRequestException(
        `Cannot create invoice for non-finalized order ${order.orderNumber}`,
      );
    }

    // 4. Validate financial totals reconciliation
    this.validateOrderFinancials(order);

    // 5. Execute in database transaction with bounded collision retry & outer idempotency recovery
    try {
      return await this.prisma.$transaction(async (tx) => {
        return this.createInvoiceInTransaction(order, tx, actorId);
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const targetStr = JSON.stringify(err.meta?.target || '');
        if (targetStr.includes('orderId') || targetStr.includes('order_id')) {
          const concurrent = await this.prisma.invoice.findUnique({
            where: { orderId: order.id },
            include: {
              items: true,
              order: { select: { orderNumber: true } },
            },
          });
          if (concurrent) {
            return mapInvoiceToDto(concurrent);
          }
        }
      }
      throw err;
    }
  }

  /**
   * Atomically creates an invoice within an existing database transaction client.
   * Handles unique constraint concurrency races safely.
   */
  async createInvoiceInTransaction(
    order: PrismaOrderWithItems,
    tx: Prisma.TransactionClient,
    actorId?: string,
  ): Promise<InvoiceDto> {
    // Check if invoice was already created in this or concurrent tx
    const existing = await tx.invoice.findUnique({
      where: { orderId: order.id },
      include: {
        items: true,
        order: { select: { orderNumber: true } },
      },
    });

    if (existing) {
      return mapInvoiceToDto(existing);
    }

    this.validateOrderFinancials(order);

    let createdInvoice: PrismaInvoiceWithItemsAndOrder | null = null;

    for (let attempt = 0; attempt < MAX_INVOICE_NUMBER_RETRIES; attempt++) {
      const invoiceNumber = generateInvoiceNumber();

      try {
        createdInvoice = await tx.invoice.create({
          data: {
            invoiceNumber,
            orderId: order.id,
            userId: order.userId,
            status: InvoiceStatus.ISSUED,
            currency: order.currency,
            subtotal: order.subtotal,
            discountTotal: order.discount || 0,
            shippingTotal: 0,
            taxTotal: order.tax || 0,
            grandTotal: order.totalAmount,

            // Customer billing snapshot from authoritative Order shipping address
            billingName: order.shippingName,
            billingPhone: order.shippingPhone,
            billingLine1: order.shippingLine1,
            billingLine2: order.shippingLine2,
            billingCity: order.shippingCity,
            billingState: order.shippingState,
            billingPostalCode: order.shippingPostalCode,
            billingCountry: order.shippingCountry,
            billingSnapshot: {
              name: order.shippingName,
              phone: order.shippingPhone,
              line1: order.shippingLine1,
              line2: order.shippingLine2,
              city: order.shippingCity,
              state: order.shippingState,
              postalCode: order.shippingPostalCode,
              country: order.shippingCountry,
            },

            // Seller snapshot
            sellerName: DEFAULT_SELLER_SNAPSHOT.sellerName,
            sellerAddressLine1: DEFAULT_SELLER_SNAPSHOT.sellerAddressLine1,
            sellerAddressLine2: DEFAULT_SELLER_SNAPSHOT.sellerAddressLine2,
            sellerCity: DEFAULT_SELLER_SNAPSHOT.sellerCity,
            sellerState: DEFAULT_SELLER_SNAPSHOT.sellerState,
            sellerPostalCode: DEFAULT_SELLER_SNAPSHOT.sellerPostalCode,
            sellerCountry: DEFAULT_SELLER_SNAPSHOT.sellerCountry,
            sellerEmail: DEFAULT_SELLER_SNAPSHOT.sellerEmail,
            sellerPhone: DEFAULT_SELLER_SNAPSHOT.sellerPhone,
            sellerGstin: DEFAULT_SELLER_SNAPSHOT.sellerGstin,
            sellerSnapshot: DEFAULT_SELLER_SNAPSHOT,

            // Immutable line items snapshot
            items: {
              create: order.items.map((item) => ({
                orderItemId: item.id,
                productId: item.productId,
                variantId: item.variantId,
                productName: item.productName,
                variantName: item.variantName,
                productSku: item.productSku,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                discountAmount: 0,
                taxableAmount: item.lineTotal,
                taxAmount: 0,
                lineTotal: item.lineTotal,
                currency: item.currency,
              })),
            },
          },
          include: {
            items: true,
            order: { select: { orderNumber: true } },
          },
        });

        // Mandatory audit record inside transaction
        await tx.auditLog.create({
          data: {
            actorId: actorId || order.userId,
            actorRole: 'SYSTEM',
            action: AuditAction.INVOICE_ISSUED,
            entityType: AuditEntityType.INVOICE,
            entityId: createdInvoice.id,
            orderId: order.id,
            amount: createdInvoice.grandTotal,
            currency: createdInvoice.currency,
            metadata: {
              invoiceNumber: createdInvoice.invoiceNumber,
              orderNumber: order.orderNumber,
            },
          },
        });

        // Emit INVOICE_ISSUED in-app notification in the SAME transaction
        if (this.notificationService) {
          await this.notificationService.createInAppNotification({
            userId: order.userId,
            eventType: NotificationEventType.INVOICE_ISSUED,
            entityType: 'invoice',
            entityId: createdInvoice.id,
            context: {
              customerName: order.shippingName || 'Customer',
              invoiceNumber: createdInvoice.invoiceNumber,
              orderNumber: order.orderNumber,
              totalAmount: (createdInvoice.grandTotal / 100).toFixed(2),
              invoiceUrl: `/invoices/${createdInvoice.id}`,
            },
            actionUrl: `/invoices/${createdInvoice.id}`,
            metadata: {
              invoiceNumber: createdInvoice.invoiceNumber,
              orderNumber: order.orderNumber,
            },
          }, tx);
        }

        break;
      } catch (err: unknown) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const targetStr = JSON.stringify(err.meta?.target || '');
          if (targetStr.includes('orderId') || targetStr.includes('order_id')) {
            try {
              // Concurrent execution already created invoice
              const concurrent = await tx.invoice.findUnique({
                where: { orderId: order.id },
                include: {
                  items: true,
                  order: { select: { orderNumber: true } },
                },
              });
              if (concurrent) {
                return mapInvoiceToDto(concurrent);
              }
            } catch {
              // If transaction was aborted by PostgreSQL, allow P2002 to bubble to outer handler
            }
          }
          if (targetStr.includes('invoiceNumber') || targetStr.includes('invoice_number')) {
            // Collision on invoiceNumber, retry
            continue;
          }
        }
        throw err;
      }
    }

    if (!createdInvoice) {
      throw new ConflictException(
        `Failed to generate unique invoice number after ${MAX_INVOICE_NUMBER_RETRIES} attempts`,
      );
    }

    return mapInvoiceToDto(createdInvoice);
  }

  // ===========================================================================
  // RETRIEVAL & OWNERSHIP
  // ===========================================================================

  /**
   * Retrieves an invoice by primary ID with ownership verification.
   */
  async getInvoiceById(invoiceId: string, currentUser?: MinimalUser): Promise<InvoiceDto> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: true,
        order: { select: { orderNumber: true } },
      },
    });

    if (!invoice) {
      throw new NotFoundException(`Invoice ${invoiceId} not found`);
    }

    if (currentUser) {
      await this.assertInvoiceAccess(invoice.userId, currentUser);
    }

    return mapInvoiceToDto(invoice);
  }

  /**
   * Retrieves an invoice by order ID with ownership verification.
   */
  async getInvoiceByOrderId(orderId: string, currentUser?: MinimalUser): Promise<InvoiceDto> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { orderId },
      include: {
        items: true,
        order: { select: { orderNumber: true } },
      },
    });

    if (!invoice) {
      throw new NotFoundException(`Invoice for order ${orderId} not found`);
    }

    if (currentUser) {
      await this.assertInvoiceAccess(invoice.userId, currentUser);
    }

    return mapInvoiceToDto(invoice);
  }

  /**
   * Admin list query with pagination and filters.
   */
  async listInvoices(
    query: AdminInvoiceListQueryDto,
    currentUser: MinimalUser,
  ): Promise<{ items: InvoiceDto[]; total: number; page: number; limit: number }> {
    const canView = await this.permissionsService.can(currentUser, Permissions.INVOICES_VIEW);
    if (!canView) {
      throw new ForbiddenException('Insufficient permissions to list invoices');
    }

    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.InvoiceWhereInput = {};

    if (query.status) {
      where.status = query.status;
    }
    if (query.userId) {
      where.userId = query.userId;
    }
    if (query.orderNumber) {
      where.order = { orderNumber: query.orderNumber };
    }
    if (query.search) {
      where.OR = [
        { invoiceNumber: { contains: query.search, mode: 'insensitive' } },
        { billingName: { contains: query.search, mode: 'insensitive' } },
        { order: { orderNumber: { contains: query.search, mode: 'insensitive' } } },
      ];
    }
    if (query.dateFrom || query.dateTo) {
      where.issuedAt = {};
      if (query.dateFrom) where.issuedAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.issuedAt.lte = new Date(query.dateTo);
    }

    const [invoices, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        skip,
        take: limit,
        orderBy: { issuedAt: 'desc' },
        include: {
          items: true,
          order: { select: { orderNumber: true } },
        },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return {
      items: invoices.map(mapInvoiceToDto),
      total,
      page,
      limit,
    };
  }

  // ===========================================================================
  // CANCELLATION (IMMUTABLE LIFECYCLE)
  // ===========================================================================

  /**
   * Cancels an issued invoice.
   * Strictly preserves historical financial snapshot fields!
   */
  async cancelInvoice(
    invoiceId: string,
    reason: string,
    adminUser: MinimalUser,
  ): Promise<InvoiceDto> {
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('Cancellation reason is required');
    }

    const canManage = await this.permissionsService.can(adminUser, Permissions.INVOICES_MANAGE);
    if (!canManage) {
      throw new ForbiddenException('Insufficient permissions to cancel invoices');
    }

    const existing = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: true,
        order: { select: { orderNumber: true } },
      },
    });

    if (!existing) {
      throw new NotFoundException(`Invoice ${invoiceId} not found`);
    }

    if (existing.status === InvoiceStatus.CANCELLED) {
      throw new BadRequestException(`Invoice ${existing.invoiceNumber} is already CANCELLED`);
    }

    // Update status and cancellation metadata without mutating ANY financial totals or item snapshots
    const updated = await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: InvoiceStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: reason.trim(),
      },
      include: {
        items: true,
        order: { select: { orderNumber: true } },
      },
    });

    // Write audit event
    await this.auditService.logEvent({
      actorId: adminUser.id,
      actorRole: adminUser.role,
      actorEmail: adminUser.email,
      action: AuditAction.INVOICE_CANCELLED,
      entityType: AuditEntityType.INVOICE,
      entityId: updated.id,
      orderId: updated.orderId,
      amount: updated.grandTotal,
      currency: updated.currency,
      previousValue: { status: InvoiceStatus.ISSUED },
      newValue: { status: InvoiceStatus.CANCELLED, cancelReason: reason.trim() },
      reason: reason.trim(),
    });

    return mapInvoiceToDto(updated);
  }

  // ===========================================================================
  // INTERNAL HELPERS & INVARIANTS
  // ===========================================================================

  /**
   * Enforces financial invariant checks between items and order totals.
   */
  private validateOrderFinancials(order: PrismaOrderWithItems): void {
    if (!order.items || order.items.length === 0) {
      throw new BadRequestException(`Order ${order.orderNumber} has no items`);
    }

    const itemsSum = order.items.reduce((sum, item) => sum + item.lineTotal, 0);
    if (itemsSum !== order.subtotal) {
      throw new BadRequestException(
        `Order financial mismatch: items line total sum (${itemsSum}) != order subtotal (${order.subtotal})`,
      );
    }

    const expectedTotal = order.subtotal - (order.discount || 0) + (order.tax || 0);
    if (order.totalAmount !== expectedTotal) {
      throw new BadRequestException(
        `Order totalAmount (${order.totalAmount}) does not reconcile with subtotal/discount/tax (${expectedTotal})`,
      );
    }
  }

  /**
   * Authorization and IDOR prevention guard.
   */
  private async assertInvoiceAccess(
    invoiceUserId: string,
    currentUser: MinimalUser,
  ): Promise<void> {
    if (currentUser.role === UserRole.SUPER_ADMIN) {
      return;
    }

    if (currentUser.id === invoiceUserId) {
      return;
    }

    const canView = await this.permissionsService.can(currentUser, Permissions.INVOICES_VIEW);
    if (canView) {
      return;
    }

    throw new ForbiddenException('You do not have permission to view this invoice');
  }
}
