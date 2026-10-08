import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Optional,
  Inject,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service.js';
import {
  ReturnStatus,
  ReturnReason,
  ReturnItemCondition,
  ReturnItemDisposition,
  RefundSource,
  RefundStatus,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import { AuditAction, AuditEntityType, UserRole, NotificationCategory, NotificationEventType } from '@vishkaraa/types';
import { AuditService } from '../audit/audit.service.js';
import type { MinimalUser } from '../permissions/permissions.service.js';
import { RefundService } from '../refunds/refund.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { NotificationService } from '../notifications/notification.service.js';

const RETURN_ELIGIBILITY_DAYS = 7;
const MAX_EVIDENCE_KEYS = 10;
const TRUSTED_EVIDENCE_URL_REGEX =
  /^https:\/\/(assets\.vishkaraa\.com|storage\.vishkaraa\.com)\/returns\/[a-zA-Z0-9_\-/]+\.(jpg|jpeg|png|webp)$/;

export function generateRmaNumber(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const fragment = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `RMA-${yyyy}${mm}-${fragment}`;
}

export function validateEvidenceKeys(keys?: string[]): void {
  if (!keys || keys.length === 0) return;
  if (keys.length > MAX_EVIDENCE_KEYS) {
    throw new BadRequestException(
      `Maximum ${MAX_EVIDENCE_KEYS} evidence keys allowed per return.`,
    );
  }
  for (const key of keys) {
    if (!key || typeof key !== 'string') {
      throw new BadRequestException('Evidence key must be a non-empty string.');
    }
    // Relative storage key (e.g. "returns/ord_123/proof_1.jpg") OR trusted URL
    const isRelativeKey =
      key.startsWith('returns/') &&
      !key.includes('..') &&
      /\.(jpg|jpeg|png|webp)$/i.test(key);
    const isTrustedUrl = TRUSTED_EVIDENCE_URL_REGEX.test(key);

    if (!isRelativeKey && !isTrustedUrl) {
      throw new BadRequestException(
        `INVALID_EVIDENCE_URL: Evidence key '${key}' does not match allowed storage path or trusted domain pattern.`,
      );
    }
  }
}

// =============================================================================
// DTOs
// =============================================================================

export interface CreateReturnItemDto {
  orderItemId: string;
  quantity: number;
  reason: ReturnReason;
  notes?: string;
}

export interface CreateReturnDto {
  items: CreateReturnItemDto[];
  customerNotes?: string;
  evidenceKeys?: string[];
  idempotencyKey?: string;
}

export interface ApproveReturnDto {
  notes?: string;
}

export interface RejectReturnDto {
  rejectionReason: string;
}

export interface ReceiveReturnDto {
  receivedQuantities: Record<string, number>;
  notes?: string;
}

export interface InspectReturnItemDto {
  orderItemId: string;
  acceptedQuantity: number;
  rejectedQuantity: number;
  condition: ReturnItemCondition;
  disposition: ReturnItemDisposition;
  notes?: string;
}

export interface InspectReturnDto {
  items: InspectReturnItemDto[];
  inspectionNotes?: string;
}

export interface AdminListReturnsQuery {
  status?: ReturnStatus;
  orderId?: string;
  userId?: string;
  rmaNumber?: string;
  page?: number;
  limit?: number;
}

export interface ReturnItemDto {
  id: string;
  orderItemId: string;
  requestedQuantity: number;
  receivedQuantity: number;
  acceptedQuantity: number;
  rejectedQuantity: number;
  reason: ReturnReason;
  customerNotes: string | null;
  condition: ReturnItemCondition | null;
  disposition: ReturnItemDisposition | null;
  inspectorNotes: string | null;
  itemRefundPaise: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReturnDto {
  id: string;
  rmaNumber: string;
  orderId: string;
  userId: string;
  status: ReturnStatus;
  customerReason: ReturnReason;
  customerNotes: string | null;
  evidenceKeys: string[];
  returnCarrier: string | null;
  trackingNumber: string | null;
  receivedAt: Date | null;
  requestedById: string;
  reviewedById: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  inspectedById: string | null;
  inspectedAt: Date | null;
  inspectionNotes: string | null;
  eligibleRefundPaise: number;
  refundedPaise: number;
  currency: string;
  idempotencyKey: string | null;
  items: ReturnItemDto[];
  createdAt: Date;
  updatedAt: Date;
}

type ReturnWithItems = Prisma.ReturnGetPayload<{ include: { items: true } }>;

function mapItemToDto(item: ReturnWithItems['items'][number]): ReturnItemDto {
  return {
    id: item.id,
    orderItemId: item.orderItemId,
    requestedQuantity: item.requestedQuantity,
    receivedQuantity: item.receivedQuantity,
    acceptedQuantity: item.acceptedQuantity,
    rejectedQuantity: item.rejectedQuantity,
    reason: item.reason,
    customerNotes: item.customerNotes,
    condition: item.condition,
    disposition: item.disposition,
    inspectorNotes: item.inspectorNotes,
    itemRefundPaise: item.itemRefundPaise,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function mapReturnToDto(ret: ReturnWithItems): ReturnDto {
  return {
    id: ret.id,
    rmaNumber: ret.rmaNumber,
    orderId: ret.orderId,
    userId: ret.userId,
    status: ret.status,
    customerReason: ret.customerReason,
    customerNotes: ret.customerNotes,
    evidenceKeys: ret.evidenceKeys ?? [],
    returnCarrier: ret.returnCarrier,
    trackingNumber: ret.trackingNumber,
    receivedAt: ret.receivedAt,
    requestedById: ret.requestedById,
    reviewedById: ret.reviewedById,
    reviewedAt: ret.reviewedAt,
    rejectionReason: ret.rejectionReason,
    inspectedById: ret.inspectedById,
    inspectedAt: ret.inspectedAt,
    inspectionNotes: ret.inspectionNotes,
    eligibleRefundPaise: ret.eligibleRefundPaise,
    refundedPaise: ret.refundedPaise,
    currency: ret.currency,
    idempotencyKey: ret.idempotencyKey,
    items: (ret.items || []).map(mapItemToDto),
    createdAt: ret.createdAt,
    updatedAt: ret.updatedAt,
  };
}

@Injectable()
export class ReturnService {
  private readonly logger = new Logger(ReturnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @Optional() @Inject(RefundService) private readonly refundService?: RefundService,
    @Optional() @Inject(InventoryService) private readonly inventoryService?: InventoryService,
    @Optional() @Inject(NotificationService) private readonly notificationService?: NotificationService,
  ) {}

  // ===========================================================================
  // 1. CREATE RETURN (Customer & Admin)
  // ===========================================================================

  async createReturn(
    orderId: string,
    actor: MinimalUser,
    dto: CreateReturnDto,
    allowWindowBypass: boolean = false,
  ): Promise<ReturnDto> {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('At least one return item is required.');
    }

    validateEvidenceKeys(dto.evidenceKeys);

    // Fast-path idempotency check
    if (dto.idempotencyKey) {
      const existing = await this.prisma.return.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
        include: { items: true },
      });
      if (existing) {
        this.logger.log(
          `[RETURN] Idempotent return retrieval for key ${dto.idempotencyKey} -> ${existing.rmaNumber}`,
        );
        return mapReturnToDto(existing);
      }
    }

    // Check duplicate items in request
    const requestedItemIds = new Set<string>();
    for (const item of dto.items) {
      if (requestedItemIds.has(item.orderItemId)) {
        throw new BadRequestException(
          `Duplicate item in return request: orderItemId ${item.orderItemId} specified multiple times.`,
        );
      }
      requestedItemIds.add(item.orderItemId);
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new BadRequestException(
          `Invalid return quantity for item ${item.orderItemId}. Must be positive integer.`,
        );
      }
    }

    // Atomic transaction for eligibility, locking, allocation checks and record creation
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          items: {
            include: {
              product: {
                select: { id: true, isReturnable: true },
              },
            },
          },
        },
      });

      if (!order) {
        throw new NotFoundException(`Order ${orderId} not found.`);
      }

      // Customer authorization: must own order
      if (actor.role === UserRole.USER && order.userId !== actor.id) {
        throw new ForbiddenException('Access denied to this order.');
      }

      // Order must be DELIVERED
      if (order.status !== OrderStatus.DELIVERED) {
        throw new BadRequestException(
          `Order ${order.orderNumber} is not in DELIVERED status (current: ${order.status}). Only delivered orders are returnable.`,
        );
      }

      // Check delivery timestamp & eligibility window
      if (!order.deliveredAt) {
        throw new BadRequestException(
          'Delivery timestamp unrecorded. Please contact support to initiate your return.',
        );
      }

      if (!allowWindowBypass) {
        const daysSinceDelivery =
          (Date.now() - order.deliveredAt.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceDelivery > RETURN_ELIGIBILITY_DAYS) {
          throw new BadRequestException(
            `Return window has expired. Returns must be requested within ${RETURN_ELIGIBILITY_DAYS} days of delivery.`,
          );
        }
      }

      const orderItemMap = new Map(order.items.map((i) => [i.id, i]));

      // Verify each requested item belongs to order and check returnability
      for (const item of dto.items) {
        const orderItem = orderItemMap.get(item.orderItemId);
        if (!orderItem) {
          throw new BadRequestException(
            `OrderItem ${item.orderItemId} does not belong to order ${orderId}.`,
          );
        }

        // Product returnability policy with statutory exception for damaged/defective items
        const isReturnable = orderItem.product?.isReturnable ?? true;
        if (!isReturnable) {
          const isStatutoryException =
            item.reason === ReturnReason.DAMAGED_PRODUCT ||
            item.reason === ReturnReason.DEFECTIVE ||
            item.reason === ReturnReason.WRONG_ITEM ||
            item.reason === ReturnReason.WRONG_PRODUCT;

          if (!isStatutoryException) {
            throw new BadRequestException(
              `Item '${orderItem.productName}' is marked as non-returnable. Discretionary returns (e.g. CHANGED_MIND) are not allowed.`,
            );
          }
        }
      }

      // Row-level lock each OrderItem to guarantee safe concurrency allocation
      for (const item of dto.items) {
        await tx.$queryRaw`
          SELECT id, quantity, "unitPrice"
          FROM order_items
          WHERE id = ${item.orderItemId}
          FOR UPDATE
        `;

        // Calculate authoritative allocated quantity per §3.1
        const existingReturnItems = await tx.returnItem.findMany({
          where: { orderItemId: item.orderItemId },
          include: { return: { select: { status: true } } },
        });

        let allocated = 0;
        for (const eri of existingReturnItems) {
          const s = eri.return.status;
          if (
            s === ReturnStatus.REQUESTED ||
            s === ReturnStatus.APPROVED ||
            s === ReturnStatus.IN_TRANSIT
          ) {
            allocated += eri.requestedQuantity;
          } else if (
            s === ReturnStatus.RECEIVED ||
            s === ReturnStatus.INSPECTING
          ) {
            allocated += eri.receivedQuantity;
          } else if (
            s === ReturnStatus.ACCEPTED ||
            s === ReturnStatus.REFUND_PENDING ||
            s === ReturnStatus.COMPLETED
          ) {
            allocated += eri.acceptedQuantity;
          }
          // REJECTED and CANCELLED contribute 0
        }

        const orderItem = orderItemMap.get(item.orderItemId)!;
        const remainingReturnable = orderItem.quantity - allocated;

        if (item.quantity > remainingReturnable) {
          throw new BadRequestException(
            `Requested return quantity (${item.quantity}) for item '${orderItem.productName}' exceeds returnable balance (${remainingReturnable}).`,
          );
        }
      }

      // Generate unique RMA Number with collision retry
      let rmaNumber = generateRmaNumber();
      let collisionRetries = 0;
      while (collisionRetries < 3) {
        const conflict = await tx.return.findUnique({ where: { rmaNumber } });
        if (!conflict) break;
        rmaNumber = generateRmaNumber();
        collisionRetries++;
      }

      const primaryReason = dto.items[0].reason;

      const createdReturn = await tx.return.create({
        data: {
          rmaNumber,
          orderId,
          userId: order.userId,
          status: ReturnStatus.REQUESTED,
          customerReason: primaryReason,
          customerNotes: dto.customerNotes?.trim() || null,
          evidenceKeys: dto.evidenceKeys ?? [],
          requestedById: actor.id,
          currency: order.currency,
          idempotencyKey: dto.idempotencyKey ?? null,
          items: {
            create: dto.items.map((it) => ({
              orderItemId: it.orderItemId,
              requestedQuantity: it.quantity,
              reason: it.reason,
              customerNotes: it.notes?.trim() || null,
            })),
          },
        },
        include: { items: true },
      });

      // Audit Log
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          actorEmail: actor.email,
          action: AuditAction.RETURN_REQUESTED,
          entityType: AuditEntityType.RETURN,
          entityId: createdReturn.id,
          orderId: order.id,
          userId: order.userId,
          newValue: JSON.stringify({
            status: ReturnStatus.REQUESTED,
            rmaNumber,
            items: dto.items,
          }),
          reason: `Return requested for order ${order.orderNumber}`,
          metadata: {
            rmaNumber,
            orderNumber: order.orderNumber,
            itemCount: dto.items.length,
          },
        },
      });

      this.logger.log(
        `[RETURN] Created return ${rmaNumber} (${createdReturn.id}) for order ${order.orderNumber} by ${actor.id}`,
      );

      return mapReturnToDto(createdReturn);
    });
  }

  async adminCreateReturn(
    orderId: string,
    actor: MinimalUser,
    dto: CreateReturnDto,
  ): Promise<ReturnDto> {
    // Admin override: allowWindowBypass is true
    return this.createReturn(orderId, actor, dto, true);
  }

  // ===========================================================================
  // 2. APPROVE RETURN (Admin with RETURNS.APPROVE)
  // ===========================================================================

  async approveReturn(
    returnId: string,
    actor: MinimalUser,
    dto: ApproveReturnDto,
  ): Promise<ReturnDto> {
    return this.prisma.$transaction(async (tx) => {
      const ret = await tx.return.findUnique({
        where: { id: returnId },
        include: { items: true },
      });

      if (!ret) {
        throw new NotFoundException(`Return ${returnId} not found.`);
      }

      if (ret.status !== ReturnStatus.REQUESTED) {
        throw new ConflictException(
          `Cannot approve return in status '${ret.status}'. Expected 'REQUESTED'.`,
        );
      }

      const updated = await tx.return.update({
        where: { id: returnId },
        data: {
          status: ReturnStatus.APPROVED,
          reviewedById: actor.id,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
        include: { items: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          actorEmail: actor.email,
          action: AuditAction.RETURN_APPROVED,
          entityType: AuditEntityType.RETURN,
          entityId: returnId,
          orderId: ret.orderId,
          userId: ret.userId,
          previousValue: JSON.stringify({ status: ret.status }),
          newValue: JSON.stringify({ status: ReturnStatus.APPROVED }),
          reason: dto.notes?.trim() || 'Return request approved by admin',
          metadata: { rmaNumber: ret.rmaNumber },
        },
      });

      if (this.notificationService) {
        const order = await tx.order.findUnique({
          where: { id: ret.orderId },
          select: { orderNumber: true },
        });

        await this.notificationService.createInAppNotification(
          {
            userId: ret.userId,
            eventType: NotificationEventType.RETURN_APPROVED,
            category: NotificationCategory.TRANSACTIONAL,
            entityType: 'return',
            entityId: ret.id,
            context: {
              returnNumber: ret.rmaNumber,
              orderNumber: order?.orderNumber || ret.orderId.slice(0, 8).toUpperCase(),
            },
            actionUrl: `/orders/${ret.orderId}`,
          },
          tx,
        );
      }

      this.logger.log(`[RETURN] ${ret.rmaNumber} APPROVED by ${actor.id}`);
      return mapReturnToDto(updated);
    });
  }

  // ===========================================================================
  // 3. REJECT RETURN (Admin with RETURNS.REJECT)
  // ===========================================================================

  async rejectReturn(
    returnId: string,
    actor: MinimalUser,
    dto: RejectReturnDto,
  ): Promise<ReturnDto> {
    if (!dto.rejectionReason || dto.rejectionReason.trim().length < 5) {
      throw new BadRequestException(
        'A substantive rejection reason (at least 5 characters) is required.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const ret = await tx.return.findUnique({
        where: { id: returnId },
        include: { items: true },
      });

      if (!ret) {
        throw new NotFoundException(`Return ${returnId} not found.`);
      }

      if (ret.status !== ReturnStatus.REQUESTED) {
        throw new ConflictException(
          `Cannot reject return in status '${ret.status}'. Expected 'REQUESTED'.`,
        );
      }

      const updated = await tx.return.update({
        where: { id: returnId },
        data: {
          status: ReturnStatus.REJECTED,
          reviewedById: actor.id,
          reviewedAt: new Date(),
          rejectionReason: dto.rejectionReason.trim(),
          updatedAt: new Date(),
        },
        include: { items: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          actorEmail: actor.email,
          action: AuditAction.RETURN_REJECTED,
          entityType: AuditEntityType.RETURN,
          entityId: returnId,
          orderId: ret.orderId,
          userId: ret.userId,
          previousValue: JSON.stringify({ status: ret.status }),
          newValue: JSON.stringify({
            status: ReturnStatus.REJECTED,
            rejectionReason: dto.rejectionReason.trim(),
          }),
          reason: dto.rejectionReason.trim(),
          metadata: { rmaNumber: ret.rmaNumber },
        },
      });

      this.logger.log(`[RETURN] ${ret.rmaNumber} REJECTED by ${actor.id}`);
      return mapReturnToDto(updated);
    });
  }

  // ===========================================================================
  // 4. RECEIVE RETURN (Warehouse operator with RETURNS.INSPECT)
  // ===========================================================================

  async receiveReturn(
    returnId: string,
    actor: MinimalUser,
    dto: ReceiveReturnDto,
  ): Promise<ReturnDto> {
    return this.prisma.$transaction(async (tx) => {
      const ret = await tx.return.findUnique({
        where: { id: returnId },
        include: { items: true },
      });

      if (!ret) {
        throw new NotFoundException(`Return ${returnId} not found.`);
      }

      const allowedStatuses: ReturnStatus[] = [
        ReturnStatus.APPROVED,
        ReturnStatus.IN_TRANSIT,
      ];
      if (!allowedStatuses.includes(ret.status)) {
        throw new ConflictException(
          `Cannot receive parcel in status '${ret.status}'. Expected 'APPROVED' or 'IN_TRANSIT'.`,
        );
      }

      // Update receivedQuantity on each item
      for (const item of ret.items) {
        const receivedQty =
          dto.receivedQuantities[item.orderItemId] ??
          dto.receivedQuantities[item.id] ??
          item.requestedQuantity; // default to requested if not explicitly specified

        if (!Number.isInteger(receivedQty) || receivedQty < 0) {
          throw new BadRequestException(
            `Received quantity for item ${item.orderItemId} must be a non-negative integer.`,
          );
        }
        if (receivedQty > item.requestedQuantity) {
          throw new BadRequestException(
            `Received quantity (${receivedQty}) cannot exceed requested quantity (${item.requestedQuantity}) for item ${item.orderItemId}.`,
          );
        }

        await tx.returnItem.update({
          where: { id: item.id },
          data: {
            receivedQuantity: receivedQty,
            updatedAt: new Date(),
          },
        });
      }

      const now = new Date();
      const updated = await tx.return.update({
        where: { id: returnId },
        data: {
          status: ReturnStatus.RECEIVED,
          receivedAt: now,
          updatedAt: now,
        },
        include: { items: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          actorEmail: actor.email,
          action: AuditAction.RETURN_RECEIVED,
          entityType: AuditEntityType.RETURN,
          entityId: returnId,
          orderId: ret.orderId,
          userId: ret.userId,
          previousValue: JSON.stringify({ status: ret.status }),
          newValue: JSON.stringify({
            status: ReturnStatus.RECEIVED,
            receivedQuantities: dto.receivedQuantities,
          }),
          reason: dto.notes?.trim() || 'Physical package received at warehouse dock',
          metadata: { rmaNumber: ret.rmaNumber },
        },
      });

      this.logger.log(`[RETURN] ${ret.rmaNumber} RECEIVED by ${actor.id}`);
      return mapReturnToDto(updated);
    });
  }

  // ===========================================================================
  // 5. INSPECT RETURN & TRIGGER REFUND (RETURNS.INSPECT)
  // ===========================================================================

  async inspectReturn(
    returnId: string,
    actor: MinimalUser,
    dto: InspectReturnDto,
  ): Promise<ReturnDto> {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('Inspection items are required.');
    }

    // Step 1: Execute inspection inside atomic transaction
    const inspectionResult = await this.prisma.$transaction(async (tx) => {
      const ret = await tx.return.findUnique({
        where: { id: returnId },
        include: {
          items: true,
          order: {
            include: { items: true },
          },
        },
      });

      if (!ret) {
        throw new NotFoundException(`Return ${returnId} not found.`);
      }

      // Idempotent recovery if called on already ACCEPTED return
      if (ret.status === ReturnStatus.ACCEPTED) {
        this.logger.log(
          `[RETURN] inspectReturn invoked on already ACCEPTED return ${ret.rmaNumber} -> delegating to reconciliation`,
        );
        return { isReconciliation: true, returnRecord: ret, triggerRefund: false, refundAmount: 0 };
      }

      const allowedStatuses: ReturnStatus[] = [
        ReturnStatus.RECEIVED,
        ReturnStatus.INSPECTING,
      ];
      if (!allowedStatuses.includes(ret.status)) {
        throw new ConflictException(
          `Cannot inspect return in status '${ret.status}'. Expected 'RECEIVED' or 'INSPECTING'.`,
        );
      }

      const returnItemMap = new Map(ret.items.map((i) => [i.orderItemId, i]));
      const orderItemMap = new Map(ret.order.items.map((i) => [i.id, i]));

      let totalAcceptedQty = 0;
      let totalEligibleRefundPaise = 0;

      // Mathematical pro-rata formula per §5.2
      const orderSubtotal = ret.order.subtotal;
      const orderDiscount = ret.order.discount;
      const orderTax = ret.order.tax;

      for (const itemDto of dto.items) {
        const retItem = returnItemMap.get(itemDto.orderItemId);
        if (!retItem) {
          throw new BadRequestException(
            `OrderItem ${itemDto.orderItemId} is not part of return ${ret.rmaNumber}.`,
          );
        }

        if (itemDto.acceptedQuantity < 0 || itemDto.rejectedQuantity < 0) {
          throw new BadRequestException(
            'Accepted and rejected quantities must be non-negative integers.',
          );
        }

        const maxProcessable =
          retItem.receivedQuantity > 0
            ? retItem.receivedQuantity
            : retItem.requestedQuantity;

        if (
          itemDto.acceptedQuantity + itemDto.rejectedQuantity >
          maxProcessable
        ) {
          throw new BadRequestException(
            `Sum of accepted (${itemDto.acceptedQuantity}) and rejected (${itemDto.rejectedQuantity}) quantities exceeds processable quantity (${maxProcessable}) for item ${itemDto.orderItemId}.`,
          );
        }

        const orderItem = orderItemMap.get(itemDto.orderItemId)!;

        // Pro-rata computation in integer paise
        let discountShare = 0;
        let taxShare = 0;
        if (orderSubtotal > 0) {
          discountShare = Math.floor(
            (orderItem.lineTotal / orderSubtotal) * orderDiscount,
          );
          taxShare = Math.floor(
            (orderItem.lineTotal / orderSubtotal) * orderTax,
          );
        }

        const netEffectiveLineTotal =
          orderItem.lineTotal - discountShare + taxShare;
        const unitRefundablePrice =
          orderItem.quantity > 0
            ? Math.floor(netEffectiveLineTotal / orderItem.quantity)
            : 0;

        let itemRefundPaise = 0;
        if (itemDto.acceptedQuantity > 0) {
          if (itemDto.acceptedQuantity === orderItem.quantity) {
            // Full item return: absorb rounding residue
            itemRefundPaise = netEffectiveLineTotal;
          } else {
            itemRefundPaise =
              itemDto.acceptedQuantity * unitRefundablePrice;
          }
        }

        await tx.returnItem.update({
          where: { id: retItem.id },
          data: {
            acceptedQuantity: itemDto.acceptedQuantity,
            rejectedQuantity: itemDto.rejectedQuantity,
            condition: itemDto.condition,
            disposition: itemDto.disposition,
            inspectorNotes: itemDto.notes?.trim() || null,
            itemRefundPaise,
            updatedAt: new Date(),
          },
        });

        if (
          this.inventoryService &&
          itemDto.disposition === ReturnItemDisposition.RESTOCK &&
          itemDto.acceptedQuantity > 0 &&
          orderItem.variantId
        ) {
          await this.inventoryService.restockReturnItem(
            {
              returnItemId: retItem.id,
              variantId: orderItem.variantId,
              quantity: itemDto.acceptedQuantity,
              actorId: actor.id,
              reason: `Return RMA ${ret.rmaNumber} inspected; item restocked`,
            },
            tx,
          );
        }

        totalAcceptedQty += itemDto.acceptedQuantity;
        totalEligibleRefundPaise += itemRefundPaise;
      }

      const now = new Date();
      const refundIdempotencyKey = `ret_ref_${ret.id}`;

      // Case 1: All items rejected -> REJECTED (terminal)
      if (totalAcceptedQty === 0) {
        const rejectedReturn = await tx.return.update({
          where: { id: returnId },
          data: {
            status: ReturnStatus.REJECTED,
            inspectedById: actor.id,
            inspectedAt: now,
            inspectionNotes:
              dto.inspectionNotes?.trim() || 'All items rejected upon inspection',
            eligibleRefundPaise: 0,
            updatedAt: now,
          },
          include: { items: true },
        });

        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            actorRole: actor.role,
            actorEmail: actor.email,
            action: AuditAction.RETURN_REJECTED,
            entityType: AuditEntityType.RETURN,
            entityId: returnId,
            orderId: ret.orderId,
            userId: ret.userId,
            previousValue: JSON.stringify({ status: ret.status }),
            newValue: JSON.stringify({
              status: ReturnStatus.REJECTED,
              acceptedQuantity: 0,
            }),
            reason: 'All items rejected during warehouse quality inspection',
            metadata: { rmaNumber: ret.rmaNumber },
          },
        });

        return { returnRecord: rejectedReturn, triggerRefund: false, refundAmount: 0 };
      }

      // Case 2: At least 1 item accepted -> ACCEPTED -> triggers refund
      const acceptedReturn = await tx.return.update({
        where: { id: returnId },
        data: {
          status: ReturnStatus.ACCEPTED,
          inspectedById: actor.id,
          inspectedAt: now,
          inspectionNotes: dto.inspectionNotes?.trim() || null,
          eligibleRefundPaise: totalEligibleRefundPaise,
          idempotencyKey: refundIdempotencyKey,
          updatedAt: now,
        },
        include: { items: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          actorEmail: actor.email,
          action: AuditAction.RETURN_INSPECTED,
          entityType: AuditEntityType.RETURN,
          entityId: returnId,
          orderId: ret.orderId,
          userId: ret.userId,
          previousValue: JSON.stringify({ status: ret.status }),
          newValue: JSON.stringify({
            status: ReturnStatus.ACCEPTED,
            acceptedQuantity: totalAcceptedQty,
            eligibleRefundPaise: totalEligibleRefundPaise,
          }),
          reason: dto.inspectionNotes?.trim() || 'Warehouse quality inspection passed',
          metadata: {
            rmaNumber: ret.rmaNumber,
            totalEligibleRefundPaise,
          },
        },
      });

      return {
        returnRecord: acceptedReturn,
        triggerRefund: true,
        refundAmount: totalEligibleRefundPaise,
        refundIdempotencyKey,
      };
    });

    if ((inspectionResult as { isReconciliation?: boolean }).isReconciliation) {
      return this.reconcileReturnRefund(returnId, actor);
    }

    if (!inspectionResult.triggerRefund) {
      return mapReturnToDto(inspectionResult.returnRecord);
    }

    // Step 2: Crash-safe Phase 09 refund integration
    if (this.refundService && inspectionResult.refundAmount > 0) {
      try {
        const refundResult = await this.refundService.createRefund(
          inspectionResult.returnRecord.orderId,
          actor,
          {
            amount: inspectionResult.refundAmount,
            reason: `Return refund for RMA ${inspectionResult.returnRecord.rmaNumber}`,
            source: RefundSource.RETURN,
            notes: `RMA: ${inspectionResult.returnRecord.rmaNumber}`,
            idempotencyKey: inspectionResult.refundIdempotencyKey,
            returnId: returnId,
          },
        );

        // Update Return status based on refund state
        const finalStatus =
          refundResult.status === RefundStatus.COMPLETED
            ? ReturnStatus.COMPLETED
            : ReturnStatus.REFUND_PENDING;

        await this.prisma.return.update({
          where: { id: returnId },
          data: {
            status: finalStatus,
            refundedPaise:
              refundResult.status === RefundStatus.COMPLETED
                ? inspectionResult.refundAmount
                : 0,
            updatedAt: new Date(),
          },
        });

        await this.prisma.auditLog.create({
          data: {
            actorId: actor.id,
            actorRole: actor.role,
            actorEmail: actor.email,
            action: AuditAction.RETURN_REFUND_REQUESTED,
            entityType: AuditEntityType.RETURN,
            entityId: returnId,
            orderId: inspectionResult.returnRecord.orderId,
            userId: inspectionResult.returnRecord.userId,
            amount: inspectionResult.refundAmount,
            currency: 'INR',
            previousValue: JSON.stringify({ status: ReturnStatus.ACCEPTED }),
            newValue: JSON.stringify({
              status: finalStatus,
              refundId: refundResult.id,
            }),
            reason: `Refund dispatched via Phase 09 engine for RMA ${inspectionResult.returnRecord.rmaNumber}`,
            metadata: {
              rmaNumber: inspectionResult.returnRecord.rmaNumber,
              refundId: refundResult.id,
            },
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        this.logger.error(
          `[RETURN] Refund dispatch failed for ${inspectionResult.returnRecord.rmaNumber}: ${message}`,
          stack,
        );
        // Leave in ACCEPTED or REFUND_PENDING for self-healing reconciliation
      }
    }

    const latest = await this.prisma.return.findUniqueOrThrow({
      where: { id: returnId },
      include: { items: true },
    });
    return mapReturnToDto(latest);
  }

  // ===========================================================================
  // 6. CANCEL RETURN (Customer for REQUESTED, Admin override)
  // ===========================================================================

  async cancelReturn(
    returnId: string,
    actor: MinimalUser,
    isAdmin: boolean,
    reason?: string,
  ): Promise<ReturnDto> {
    return this.prisma.$transaction(async (tx) => {
      const ret = await tx.return.findUnique({
        where: { id: returnId },
        include: { items: true },
      });

      if (!ret) {
        throw new NotFoundException(`Return ${returnId} not found.`);
      }

      const terminalStatuses = new Set<ReturnStatus>([
        ReturnStatus.COMPLETED,
        ReturnStatus.REJECTED,
        ReturnStatus.CANCELLED,
        ReturnStatus.REFUND_PENDING,
      ]);

      if (terminalStatuses.has(ret.status)) {
        throw new ConflictException(
          `Cannot cancel return in terminal status '${ret.status}'.`,
        );
      }

      if (!isAdmin) {
        if (ret.userId !== actor.id) {
          throw new ForbiddenException('Not authorized to cancel this return.');
        }
        if (ret.status !== ReturnStatus.REQUESTED) {
          throw new ConflictException(
            `Customer can only cancel return in 'REQUESTED' status. Current status: '${ret.status}'.`,
          );
        }
      }

      const updated = await tx.return.update({
        where: { id: returnId },
        data: {
          status: ReturnStatus.CANCELLED,
          updatedAt: new Date(),
        },
        include: { items: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          actorEmail: actor.email,
          action: AuditAction.RETURN_CANCELLED,
          entityType: AuditEntityType.RETURN,
          entityId: returnId,
          orderId: ret.orderId,
          userId: ret.userId,
          previousValue: JSON.stringify({ status: ret.status }),
          newValue: JSON.stringify({ status: ReturnStatus.CANCELLED }),
          reason:
            reason ||
            (isAdmin
              ? 'Admin operational cancellation'
              : 'Customer cancellation'),
          metadata: { rmaNumber: ret.rmaNumber },
        },
      });

      this.logger.log(`[RETURN] ${ret.rmaNumber} CANCELLED by ${actor.id}`);
      return mapReturnToDto(updated);
    });
  }

  // ===========================================================================
  // 7. QUERY METHODS (Guarded)
  // ===========================================================================

  async getReturn(
    returnId: string,
    actor: MinimalUser,
    isAdmin: boolean,
  ): Promise<ReturnDto> {
    const ret = await this.prisma.return.findUnique({
      where: { id: returnId },
      include: { items: true },
    });

    if (!ret) {
      throw new NotFoundException(`Return ${returnId} not found.`);
    }

    if (!isAdmin && ret.userId !== actor.id) {
      throw new ForbiddenException('Access denied to this return record.');
    }

    // Self-healing check: if return is stuck in ACCEPTED with eligibleRefundPaise > 0, reconcile it
    if (ret.status === ReturnStatus.ACCEPTED && ret.eligibleRefundPaise > 0) {
      try {
        return await this.reconcileReturnRefund(returnId, actor);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[RETURN] Self-healing reconciliation on read failed for ${ret.rmaNumber}: ${message}`,
        );
      }
    }

    return mapReturnToDto(ret);
  }

  async getReturnsForOrder(
    orderId: string,
    actor: MinimalUser,
  ): Promise<ReturnDto[]> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { userId: true },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found.`);
    }

    if (actor.role === UserRole.USER && order.userId !== actor.id) {
      throw new ForbiddenException('Access denied to this order.');
    }

    const returns = await this.prisma.return.findMany({
      where: { orderId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });

    return returns.map(mapReturnToDto);
  }

  async adminListReturns(query: AdminListReturnsQuery): Promise<ReturnDto[]> {
    const where: Prisma.ReturnWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.orderId) where.orderId = query.orderId;
    if (query.userId) where.userId = query.userId;
    if (query.rmaNumber) {
      where.rmaNumber = { contains: query.rmaNumber, mode: 'insensitive' };
    }

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const returns = await this.prisma.return.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return returns.map(mapReturnToDto);
  }

  // ===========================================================================
  // 8. CRASH RECOVERY & RECONCILIATION
  // ===========================================================================

  async reconcileReturnRefund(
    returnId: string,
    actor?: MinimalUser,
  ): Promise<ReturnDto> {
    const ret = await this.prisma.return.findUnique({
      where: { id: returnId },
      include: { items: true },
    });

    if (!ret) {
      throw new NotFoundException(`Return ${returnId} not found.`);
    }

    // Never regress COMPLETED
    if (ret.status === ReturnStatus.COMPLETED) {
      return mapReturnToDto(ret);
    }

    // Terminal statuses CANCELLED / REJECTED cannot have refunds reconciled
    if (
      ret.status === ReturnStatus.CANCELLED ||
      ret.status === ReturnStatus.REJECTED
    ) {
      throw new ConflictException(
        `Cannot reconcile refund for return in terminal status '${ret.status}'.`,
      );
    }

    // Must be ACCEPTED or REFUND_PENDING
    if (
      ret.status !== ReturnStatus.ACCEPTED &&
      ret.status !== ReturnStatus.REFUND_PENDING
    ) {
      throw new ConflictException(
        `Cannot reconcile refund for return in status '${ret.status}'. Expected 'ACCEPTED' or 'REFUND_PENDING'.`,
      );
    }

    // If 0 eligible refund paise, return is complete
    if (ret.eligibleRefundPaise === 0) {
      const updated = await this.prisma.return.update({
        where: { id: returnId },
        data: {
          status: ReturnStatus.COMPLETED,
          refundedPaise: 0,
          updatedAt: new Date(),
        },
        include: { items: true },
      });
      return mapReturnToDto(updated);
    }

    const deterministicKey = `ret_ref_${ret.id}`;

    // Find linked Refund by idempotencyKey or returnId
    const existingRefund = await this.prisma.refund.findFirst({
      where: {
        OR: [
          { idempotencyKey: deterministicKey },
          { returnId: ret.id },
        ],
      },
      include: { attempts: true },
    });

    // Case 1: No Refund exists (Crash before createRefund or failure to initiate)
    if (!existingRefund) {
      if (!this.refundService) {
        this.logger.warn(
          `[RETURN RECONCILE] RefundService not available to create refund for ${ret.rmaNumber}`,
        );
        return mapReturnToDto(ret);
      }

      // Re-initiate refund using deterministic idempotency key and safe actor
      const systemActor: MinimalUser = actor ?? {
        id: ret.inspectedById ?? ret.requestedById,
        role: UserRole.ADMIN,
        email: 'system-reconciliation@vishkaraa.local',
      };

      try {
        const refundResult = await this.refundService.createRefund(
          ret.orderId,
          systemActor,
          {
            amount: ret.eligibleRefundPaise,
            reason: `Return refund for RMA ${ret.rmaNumber}`,
            source: RefundSource.RETURN,
            notes: `RMA: ${ret.rmaNumber} (Reconciliation)`,
            idempotencyKey: deterministicKey,
            returnId: ret.id,
          },
        );

        const targetStatus =
          refundResult.status === RefundStatus.COMPLETED
            ? ReturnStatus.COMPLETED
            : ReturnStatus.REFUND_PENDING;

        const updated = await this.prisma.return.update({
          where: { id: returnId },
          data: {
            status: targetStatus,
            refundedPaise:
              refundResult.status === RefundStatus.COMPLETED
                ? ret.eligibleRefundPaise
                : 0,
            updatedAt: new Date(),
          },
          include: { items: true },
        });

        await this.prisma.auditLog.create({
          data: {
            actorId: systemActor.id,
            actorRole: systemActor.role,
            action:
              targetStatus === ReturnStatus.COMPLETED
                ? AuditAction.RETURN_COMPLETED
                : AuditAction.RETURN_REFUND_REQUESTED,
            entityType: AuditEntityType.RETURN,
            entityId: returnId,
            orderId: ret.orderId,
            userId: ret.userId,
            amount: ret.eligibleRefundPaise,
            currency: ret.currency,
            previousValue: JSON.stringify({ status: ret.status }),
            newValue: JSON.stringify({
              status: targetStatus,
              refundId: refundResult.id,
            }),
            reason: `Refund initiated via reconciliation for RMA ${ret.rmaNumber}`,
            metadata: { rmaNumber: ret.rmaNumber, refundId: refundResult.id },
          },
        });

        this.logger.log(
          `[RETURN RECONCILE] Initiated refund for ${ret.rmaNumber} -> ${targetStatus}`,
        );
        return mapReturnToDto(updated);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[RETURN RECONCILE] Failed to initiate refund for ${ret.rmaNumber}: ${message}`,
        );
        return mapReturnToDto(ret);
      }
    }

    // Case 2: Refund exists (Crash after createRefund or async state transition)
    let targetStatus: ReturnStatus = ret.status;
    let targetRefundedPaise = ret.refundedPaise;

    switch (existingRefund.status) {
      case RefundStatus.COMPLETED:
        targetStatus = ReturnStatus.COMPLETED;
        targetRefundedPaise =
          existingRefund.refundedAmount > 0
            ? existingRefund.refundedAmount
            : existingRefund.amount;
        break;

      case RefundStatus.PROCESSING:
      case RefundStatus.APPROVED:
      case RefundStatus.REQUESTED:
        targetStatus = ReturnStatus.REFUND_PENDING;
        break;

      case RefundStatus.FAILED:
        // Keep in REFUND_PENDING for controlled admin retry
        targetStatus = ReturnStatus.REFUND_PENDING;
        break;

      case RefundStatus.REJECTED:
      case RefundStatus.CANCELLED:
        // Preserved in terminal state
        break;
    }

    // Idempotent no-op if status and refunded amount already match
    if (
      ret.status === targetStatus &&
      ret.refundedPaise === targetRefundedPaise
    ) {
      return mapReturnToDto(ret);
    }

    const updated = await this.prisma.return.update({
      where: { id: returnId },
      data: {
        status: targetStatus,
        refundedPaise: targetRefundedPaise,
        updatedAt: new Date(),
      },
      include: { items: true },
    });

    // Write audit log only if status actually changed
    if (ret.status !== targetStatus) {
      await this.prisma.auditLog.create({
        data: {
          actorId: actor?.id ?? 'SYSTEM',
          actorRole: actor?.role ?? 'SYSTEM',
          action:
            targetStatus === ReturnStatus.COMPLETED
              ? AuditAction.RETURN_COMPLETED
              : AuditAction.RETURN_REFUND_REQUESTED,
          entityType: AuditEntityType.RETURN,
          entityId: returnId,
          orderId: ret.orderId,
          userId: ret.userId,
          amount: targetRefundedPaise,
          currency: ret.currency,
          previousValue: JSON.stringify({ status: ret.status }),
          newValue: JSON.stringify({
            status: targetStatus,
            refundId: existingRefund.id,
          }),
          reason: `Return status reconciled to ${targetStatus} based on Refund ${existingRefund.refundNumber}`,
          metadata: {
            rmaNumber: ret.rmaNumber,
            refundId: existingRefund.id,
            refundStatus: existingRefund.status,
          },
        },
      });
    }

    this.logger.log(
      `[RETURN RECONCILE] ${ret.rmaNumber} reconciled from ${ret.status} to ${targetStatus}`,
    );
    return mapReturnToDto(updated);
  }

  // ===========================================================================
  // 9. ASYNC RECONCILIATION HOOK
  // ===========================================================================

  async onRefundSettled(
    returnIdempotencyKey: string,
    settledAmountPaise: number,
  ): Promise<void> {
    const ret = await this.prisma.return.findUnique({
      where: { idempotencyKey: returnIdempotencyKey },
    });

    if (!ret) return;

    // Invariant: Never regress COMPLETED
    if (ret.status === ReturnStatus.COMPLETED) {
      return;
    }

    // Must be either REFUND_PENDING or ACCEPTED (crash recovery path)
    if (
      ret.status !== ReturnStatus.REFUND_PENDING &&
      ret.status !== ReturnStatus.ACCEPTED
    ) {
      return;
    }

    // Verify refund actually exists for this return
    const refund = await this.prisma.refund.findFirst({
      where: {
        OR: [
          { idempotencyKey: returnIdempotencyKey },
          { returnId: ret.id },
        ],
      },
    });

    if (!refund) {
      this.logger.warn(
        `[RETURN] onRefundSettled received for ${ret.rmaNumber} but no linked Refund row was found. Rejecting transition.`,
      );
      return;
    }

    await this.prisma.return.update({
      where: { id: ret.id },
      data: {
        status: ReturnStatus.COMPLETED,
        refundedPaise: settledAmountPaise,
        updatedAt: new Date(),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: 'SYSTEM',
        actorRole: 'SYSTEM',
        action: AuditAction.RETURN_COMPLETED,
        entityType: AuditEntityType.RETURN,
        entityId: ret.id,
        orderId: ret.orderId,
        userId: ret.userId,
        amount: settledAmountPaise,
        currency: ret.currency,
        previousValue: JSON.stringify({ status: ret.status }),
        newValue: JSON.stringify({
          status: ReturnStatus.COMPLETED,
          refundedPaise: settledAmountPaise,
        }),
        reason: 'Return completed after gateway refund settlement confirmation',
        metadata: { rmaNumber: ret.rmaNumber, refundId: refund.id },
      },
    });

    this.logger.log(
      `[RETURN] ${ret.rmaNumber} COMPLETED after refund settlement.`,
    );
  }
}