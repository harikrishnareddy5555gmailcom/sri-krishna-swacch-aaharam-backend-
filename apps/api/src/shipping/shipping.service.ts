import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  Prisma,
  ShipmentStatus,
  OrderStatus,
} from '@prisma/client';
import {
  AuditAction,
  AuditEntityType,
  Permissions,
  UserRole,
  NotificationCategory,
  NotificationEventType,
  type NotificationEventTypeString,
  type ShipmentDto,
  type ShipmentEventDto,
  type CustomerShipmentDto,
  type AdminShipmentDto,
  type AdminShipmentListDto,
} from '@vishkaraa/types';
import { validateTrackingUrl } from './providers/tracking-url.util.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  PermissionsService,
  type MinimalUser,
} from '../permissions/permissions.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { CreateShipmentDto } from './dto/create-shipment.dto.js';
import { UpdateShipmentStatusDto } from './dto/update-shipment-status.dto.js';
import { CancelShipmentDto } from './dto/cancel-shipment.dto.js';
import { AdminListShipmentsQueryDto, ShippingQueryDto } from './dto/shipping-query.dto.js';
import { ReconcileShipmentDto } from './dto/reconcile-shipment.dto.js';
import { type NormalizedShipmentEvent } from './providers/shipping-provider.interface.js';
import { NotificationService } from '../notifications/notification.service.js';

// =============================================================================
// SHIPMENT NUMBER GENERATOR
// =============================================================================
export function generateShipmentNumber(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const fragment = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `SHP-${yyyy}${mm}-${fragment}`;
}

// =============================================================================
// CANONICAL STATE MACHINE TRANSITION RULES
// =============================================================================
export const ALLOWED_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  [ShipmentStatus.CREATED]: [
    ShipmentStatus.PACKING,
    ShipmentStatus.CANCELLED,
  ],
  [ShipmentStatus.PACKING]: [
    ShipmentStatus.PACKED,
    ShipmentStatus.CANCELLED,
  ],
  [ShipmentStatus.PACKED]: [
    ShipmentStatus.READY_TO_SHIP,
    ShipmentStatus.CANCELLED,
  ],
  [ShipmentStatus.READY_TO_SHIP]: [
    ShipmentStatus.SHIPPED,
    ShipmentStatus.CANCELLED,
  ],
  [ShipmentStatus.SHIPPED]: [
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.IN_TRANSIT]: [
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERY_FAILED,
    ShipmentStatus.RTO_INITIATED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.OUT_FOR_DELIVERY]: [
    ShipmentStatus.DELIVERED,
    ShipmentStatus.DELIVERY_FAILED,
    ShipmentStatus.RTO_INITIATED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.DELIVERY_FAILED]: [
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.RTO_INITIATED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.RTO_INITIATED]: [
    ShipmentStatus.RTO_DELIVERED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.DELIVERED]: [],      // Terminal
  [ShipmentStatus.RTO_DELIVERED]: [],  // Terminal
  [ShipmentStatus.CANCELLED]: [],      // Terminal
  [ShipmentStatus.LOST]: [],           // Terminal
};

/**
 * Permitted forward leaps and transitions for PROVIDER_WEBHOOK authority.
 * Webhooks can skip intermediate local/carrier hub milestones (e.g. SHIPPED -> OUT_FOR_DELIVERY),
 * but can NEVER regress backward or mutate terminal states.
 */
export const WEBHOOK_ALLOWED_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  [ShipmentStatus.CREATED]: [ShipmentStatus.READY_TO_SHIP, ShipmentStatus.SHIPPED],
  [ShipmentStatus.PACKING]: [ShipmentStatus.READY_TO_SHIP, ShipmentStatus.SHIPPED],
  [ShipmentStatus.PACKED]: [ShipmentStatus.READY_TO_SHIP, ShipmentStatus.SHIPPED],
  [ShipmentStatus.READY_TO_SHIP]: [
    ShipmentStatus.SHIPPED,
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.SHIPPED]: [
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.DELIVERY_FAILED,
    ShipmentStatus.RTO_INITIATED,
    ShipmentStatus.RTO_DELIVERED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.IN_TRANSIT]: [
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.DELIVERY_FAILED,
    ShipmentStatus.RTO_INITIATED,
    ShipmentStatus.RTO_DELIVERED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.OUT_FOR_DELIVERY]: [
    ShipmentStatus.DELIVERED,
    ShipmentStatus.DELIVERY_FAILED,
    ShipmentStatus.RTO_INITIATED,
    ShipmentStatus.RTO_DELIVERED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.DELIVERY_FAILED]: [
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.RTO_INITIATED,
    ShipmentStatus.RTO_DELIVERED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.RTO_INITIATED]: [
    ShipmentStatus.RTO_DELIVERED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.DELIVERED]: [],
  [ShipmentStatus.RTO_DELIVERED]: [],
  [ShipmentStatus.CANCELLED]: [],
  [ShipmentStatus.LOST]: [],
};

/**
 * Permitted manual resolution targets for administrative reconciliation under SHIPPING_RECONCILE.
 * Prevents arbitrary state regressions while allowing valid operator corrections.
 */
export const RECONCILIATION_ALLOWED_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  [ShipmentStatus.CREATED]: [
    ShipmentStatus.PACKING,
    ShipmentStatus.PACKED,
    ShipmentStatus.READY_TO_SHIP,
    ShipmentStatus.CANCELLED,
  ],
  [ShipmentStatus.PACKING]: [
    ShipmentStatus.PACKED,
    ShipmentStatus.READY_TO_SHIP,
    ShipmentStatus.CANCELLED,
  ],
  [ShipmentStatus.PACKED]: [
    ShipmentStatus.READY_TO_SHIP,
    ShipmentStatus.SHIPPED,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.CANCELLED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.READY_TO_SHIP]: [
    ShipmentStatus.SHIPPED,
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.CANCELLED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.SHIPPED]: [
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.DELIVERY_FAILED,
    ShipmentStatus.RTO_INITIATED,
    ShipmentStatus.RTO_DELIVERED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.IN_TRANSIT]: [
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.DELIVERY_FAILED,
    ShipmentStatus.RTO_INITIATED,
    ShipmentStatus.RTO_DELIVERED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.OUT_FOR_DELIVERY]: [
    ShipmentStatus.DELIVERED,
    ShipmentStatus.DELIVERY_FAILED,
    ShipmentStatus.RTO_INITIATED,
    ShipmentStatus.RTO_DELIVERED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.DELIVERY_FAILED]: [
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.RTO_INITIATED,
    ShipmentStatus.RTO_DELIVERED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.RTO_INITIATED]: [
    ShipmentStatus.RTO_DELIVERED,
    ShipmentStatus.LOST,
  ],
  [ShipmentStatus.DELIVERED]: [],
  [ShipmentStatus.RTO_DELIVERED]: [],
  [ShipmentStatus.CANCELLED]: [],
  [ShipmentStatus.LOST]: [],
};

type ShipmentRow = {
  id: string;
  shipmentNumber: string;
  orderId: string;
  userId: string;
  status: ShipmentStatus;
  previousStatus: ShipmentStatus | null;
  carrierCode: string;
  carrierName: string;
  serviceType: string | null;
  trackingNumber: string | null;
  providerShipmentId: string | null;
  weightGrams: number;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  isCod: boolean;
  codAmountPaise: number;
  labelUrl: string | null;
  manifestUrl: string | null;
  invoiceId: string | null;
  packedAt: Date | null;
  shippedAt: Date | null;
  outForDeliveryAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  lastEventTimestamp: Date | null;
  version: number;
  reconciliationRequired: boolean;
  reconciliationNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export const PRE_DISPATCH_STATUSES = new Set<ShipmentStatus>([
  ShipmentStatus.CREATED,
  ShipmentStatus.PACKING,
  ShipmentStatus.PACKED,
  ShipmentStatus.READY_TO_SHIP,
]);

export const TERMINAL_STATUSES = new Set<ShipmentStatus>([
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RTO_DELIVERED,
  ShipmentStatus.CANCELLED,
  ShipmentStatus.LOST,
]);

export type PrismaShipmentWithItemsAndEvents = Prisma.ShipmentGetPayload<{
  include: {
    items: true;
    events: true;
  };
}>;

@Injectable()
export class ShipmentService {
  private readonly logger = new Logger(ShipmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly permissionsService: PermissionsService,
    private readonly inventoryService: InventoryService,
    @Optional()
    @Inject(NotificationService)
    private readonly notificationService?: NotificationService,
  ) {}

  private async emitShipmentNotification(
    targetStatus: ShipmentStatus,
    shipment: {
      id: string;
      shipmentNumber: string;
      orderId: string;
      userId: string;
      carrierName?: string | null;
      trackingNumber?: string | null;
    },
    tx: Prisma.TransactionClient,
    reason?: string,
  ): Promise<void> {
    if (!this.notificationService) return;

    let eventType: NotificationEventTypeString | undefined;
    if (targetStatus === ShipmentStatus.SHIPPED) {
      eventType = NotificationEventType.SHIPMENT_DISPATCHED;
    } else if (targetStatus === ShipmentStatus.OUT_FOR_DELIVERY) {
      eventType = NotificationEventType.SHIPMENT_OUT_FOR_DELIVERY;
    } else if (targetStatus === ShipmentStatus.DELIVERED) {
      eventType = NotificationEventType.SHIPMENT_DELIVERED;
    } else if (targetStatus === ShipmentStatus.DELIVERY_FAILED) {
      eventType = NotificationEventType.SHIPMENT_FAILED;
    }

    if (!eventType) return;

    const order = await tx.order.findUnique({
      where: { id: shipment.orderId },
      select: { orderNumber: true },
    });

    const orderNumber = order?.orderNumber || shipment.orderId.slice(0, 8).toUpperCase();

    const context: Record<string, unknown> = {
      shipmentNumber: shipment.shipmentNumber,
      orderNumber,
      carrierName: shipment.carrierName || 'Courier Partner',
      trackingNumber: shipment.trackingNumber ?? undefined,
      reason: reason ?? undefined,
    };

    await this.notificationService.createInAppNotification(
      {
        userId: shipment.userId,
        eventType,
        category: NotificationCategory.TRANSACTIONAL,
        entityType: 'shipment',
        entityId: shipment.id,
        context,
        actionUrl: `/orders/${shipment.orderId}`,
      },
      tx,
    );
  }

  // ---------------------------------------------------------------------------
  // 1. SHIPMENT CREATION WITH DETERMINISTIC LOCKING
  // ---------------------------------------------------------------------------

  /**
   * Creates a Shipment and allocates line items from an Order.
   *
   * Physical Concurrency & Invariant Enforcement:
   * 1. Deterministically locks Order row (FOR UPDATE).
   * 2. Deterministically locks requested OrderItems ordered by ID ASC (FOR UPDATE).
   * 3. Calculates remaining unallocated quantities under row locks.
   * 4. Enforces: alreadyAllocated + requestedQty <= orderItem.quantity.
   * 5. Atomically creates Shipment, ShipmentItems, and initial ShipmentEvent.
   * 6. Appends AuditLog in the same transaction.
   */
  async createShipment(
    actor: MinimalUser,
    input: CreateShipmentDto,
  ): Promise<ShipmentDto> {
    // 1. Authorization check
    await this.assertPermission(actor, Permissions.SHIPPING_CREATE);

    // 2. Validate input shape
    if (!input.items || input.items.length === 0) {
      throw new BadRequestException('Shipment must contain at least one order item');
    }

    const orderItemIds = input.items.map((i) => i.orderItemId);
    if (new Set(orderItemIds).size !== orderItemIds.length) {
      throw new BadRequestException('Duplicate order items specified in shipment creation');
    }

    for (const itm of input.items) {
      if (!Number.isInteger(itm.quantity) || itm.quantity <= 0) {
        throw new BadRequestException(
          `Shipment item quantity must be a positive integer: got ${itm.quantity}`,
        );
      }
    }

    return await this.prisma.$transaction(async (tx) => {
      // 3. Acquire pessimistic row lock on Order
      const orderRows: Array<{
        id: string;
        orderNumber: string;
        userId: string;
        status: OrderStatus;
        totalAmount: number;
        currency: string;
      }> = await tx.$queryRaw`
        SELECT id, "orderNumber", "userId", status, "totalAmount", currency
        FROM orders
        WHERE id = ${input.orderId}
        FOR UPDATE
      `;

      if (orderRows.length === 0) {
        throw new NotFoundException(`Order ${input.orderId} not found`);
      }
      const order = orderRows[0];

      if (order.status === OrderStatus.CANCELLED) {
        throw new BadRequestException('Cannot create shipment for a cancelled order');
      }

      if (
        order.status !== OrderStatus.CONFIRMED &&
        order.status !== OrderStatus.PROCESSING &&
        order.status !== OrderStatus.SHIPPED
      ) {
        throw new BadRequestException(
          `Cannot create shipment for order in status ${order.status}`,
        );
      }

      // 4. Deadlock-free row locks on OrderItems ordered by ID ASC
      const sortedOrderItemIds = [...orderItemIds].sort();
      const lockedOrderItems: Array<{
        id: string;
        orderId: string;
        variantId: string | null;
        productName: string;
        variantName: string | null;
        productSku: string;
        quantity: number;
      }> = await tx.$queryRaw`
        SELECT id, "orderId", "variantId", "productName", "variantName", "productSku", quantity
        FROM order_items
        WHERE id IN (${Prisma.join(sortedOrderItemIds)})
        ORDER BY id ASC
        FOR UPDATE
      `;

      if (lockedOrderItems.length !== sortedOrderItemIds.length) {
        throw new NotFoundException('One or more requested OrderItems were not found');
      }

      for (const oi of lockedOrderItems) {
        if (oi.orderId !== input.orderId) {
          throw new BadRequestException(
            `OrderItem ${oi.id} does not belong to Order ${input.orderId}`,
          );
        }
        if (!oi.variantId) {
          throw new BadRequestException(
            `OrderItem ${oi.id} has no linked product variant`,
          );
        }
      }

      // 5. Compute existing allocated quantities across active (non-cancelled) shipments
      const existingAllocations: Array<{
        orderItemId: string;
        allocatedQty: number;
      }> = await tx.$queryRaw`
        SELECT si."orderItemId", COALESCE(SUM(si.quantity), 0)::int as "allocatedQty"
        FROM shipment_items si
        JOIN shipments s ON s.id = si."shipmentId"
        WHERE si."orderItemId" IN (${Prisma.join(sortedOrderItemIds)})
          AND s.status NOT IN ('CANCELLED')
        GROUP BY si."orderItemId"
      `;

      const allocationMap = new Map<string, number>(
        existingAllocations.map((a) => [a.orderItemId, a.allocatedQty]),
      );

      // 6. Validate quantity invariants under row lock
      for (const itm of input.items) {
        const orderItem = lockedOrderItems.find((o) => o.id === itm.orderItemId)!;
        const alreadyAllocated = allocationMap.get(itm.orderItemId) || 0;
        const remaining = orderItem.quantity - alreadyAllocated;

        if (itm.quantity > remaining) {
          throw new ConflictException(
            `OVER_ALLOCATION: OrderItem ${orderItem.id} (${orderItem.productName}) has ${alreadyAllocated}/${orderItem.quantity} already allocated. Remaining available is ${remaining}, but requested ${itm.quantity}.`,
          );
        }
      }

      // 7. Generate collision-resistant unique shipmentNumber
      let shipmentNumber = generateShipmentNumber();
      let attempts = 0;
      while (attempts < 3) {
        const existing = await tx.shipment.findUnique({
          where: { shipmentNumber },
        });
        if (!existing) break;
        shipmentNumber = generateShipmentNumber();
        attempts++;
      }

      const carrierCode = input.carrierCode || 'MANUAL';
      const carrierName = input.carrierName || 'Manual / Local Dispatch';

      // 8. Create Shipment and ShipmentItems atomically
      const shipment = await tx.shipment.create({
        data: {
          shipmentNumber,
          orderId: input.orderId,
          userId: order.userId,
          status: ShipmentStatus.CREATED,
          carrierCode,
          carrierName,
          serviceType: input.serviceType,
          trackingNumber: input.trackingNumber,
          providerShipmentId: input.providerShipmentId,
          weightGrams: input.weightGrams ?? 0,
          lengthCm: input.lengthCm,
          widthCm: input.widthCm,
          heightCm: input.heightCm,
          isCod: input.isCod ?? false,
          codAmountPaise: input.codAmountPaise ?? 0,
          labelUrl: input.labelUrl,
          manifestUrl: input.manifestUrl,
          invoiceId: input.invoiceId,
          version: 1,
          items: {
            create: input.items.map((itm) => {
              const oi = lockedOrderItems.find((o) => o.id === itm.orderItemId)!;
              return {
                orderItemId: oi.id,
                variantId: oi.variantId!,
                productName: oi.productName,
                variantName: oi.variantName,
                productSku: oi.productSku,
                quantity: itm.quantity,
              };
            }),
          },
          events: {
            create: {
              status: ShipmentStatus.CREATED,
              description: 'Shipment created and allocated from order',
              eventTimestamp: new Date(),
            },
          },
        },
        include: {
          items: true,
          events: true,
        },
      });

      // 9. Mandatory AuditLog inside the transaction
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          actorEmail: actor.email,
          action: AuditAction.SHIPMENT_CREATED,
          entityType: AuditEntityType.SHIPMENT,
          entityId: shipment.id,
          orderId: order.id,
          userId: order.userId,
          amount: order.totalAmount,
          currency: order.currency,
          newValue: JSON.stringify({
            shipmentId: shipment.id,
            shipmentNumber: shipment.shipmentNumber,
            carrierCode,
            itemCount: shipment.items.length,
          }),
          reason: `Shipment ${shipment.shipmentNumber} created for Order ${order.orderNumber}`,
          metadata: {
            orderNumber: order.orderNumber,
            carrierCode,
            trackingNumber: input.trackingNumber,
          },
        },
      });

      this.logger.log(
        `[SHIPMENT] Created ${shipment.shipmentNumber} for Order ${order.orderNumber} by ${actor.role}(${actor.id})`,
      );

      return this.mapToDto(shipment);
    });
  }

  // ---------------------------------------------------------------------------
  // 2. STATE TRANSITIONS & STATE MACHINE ENGINE
  // ---------------------------------------------------------------------------

  /**
   * Executes a controlled canonical state transition.
   *
   * Guarantees:
   * - Deterministic row lock on Shipment (FOR UPDATE).
   * - Optimistic / row lock concurrency safety against competing updates.
   * - Idempotent for identical target state (safe no-op).
   * - Enforces canonical state transition table; rejects backward transitions.
   * - Preserves terminal states (DELIVERED, RTO_DELIVERED, CANCELLED, LOST).
   * - On SHIPPED: atomically triggers physical inventory deduction via InventoryService.
   * - On DELIVERED: atomically evaluates Order delivery completeness.
   */
  async updateShipmentStatus(
    shipmentId: string,
    actor: MinimalUser,
    input: UpdateShipmentStatusDto,
  ): Promise<ShipmentDto> {
    await this.assertPermission(actor, Permissions.SHIPPING_UPDATE);

    const targetStatus = input.status;

    return await this.prisma.$transaction(async (tx) => {
      // 1. Establish deterministic lock hierarchy: orders -> shipments
      const meta = await tx.shipment.findUnique({
        where: { id: shipmentId },
        select: { id: true, orderId: true },
      });
      if (!meta) {
        throw new NotFoundException(`Shipment ${shipmentId} not found`);
      }

      await tx.$queryRaw`
        SELECT id FROM orders WHERE id = ${meta.orderId} FOR UPDATE
      `;

      // 2. Lock shipment row for update
      const shipmentRows = await tx.$queryRaw<Array<{
        id: string;
        shipmentNumber: string;
        orderId: string;
        userId: string;
        status: ShipmentStatus;
        previousStatus: ShipmentStatus | null;
        carrierCode: string;
        carrierName: string;
        serviceType: string | null;
        trackingNumber: string | null;
        providerShipmentId: string | null;
        weightGrams: number;
        lengthCm: number | null;
        widthCm: number | null;
        heightCm: number | null;
        isCod: boolean;
        codAmountPaise: number;
        labelUrl: string | null;
        manifestUrl: string | null;
        invoiceId: string | null;
        packedAt: Date | null;
        shippedAt: Date | null;
        outForDeliveryAt: Date | null;
        deliveredAt: Date | null;
        cancelledAt: Date | null;
        cancelReason: string | null;
        lastEventTimestamp: Date | null;
        version: number;
        reconciliationRequired: boolean;
        reconciliationNotes: string | null;
        createdAt: Date;
        updatedAt: Date;
      }>>`
        SELECT *
        FROM shipments
        WHERE id = ${shipmentId}
        FOR UPDATE
      `;

      if (shipmentRows.length === 0) {
        throw new NotFoundException(`Shipment ${shipmentId} not found`);
      }
      const current = shipmentRows[0];

      // 2. Idempotency: same status is a safe no-op
      if (current.status === targetStatus) {
        this.logger.log(
          `[SHIPMENT] Idempotent status update: shipment ${current.shipmentNumber} is already in status ${targetStatus}`,
        );
        const fullShipment = await tx.shipment.findUnique({
          where: { id: shipmentId },
          include: { items: true, events: true },
        });
        return this.mapToDto(fullShipment!);
      }

      // 3. Terminal state protection
      if (TERMINAL_STATUSES.has(current.status)) {
        throw new ConflictException(
          `TERMINAL_STATE: Cannot transition shipment ${current.shipmentNumber} from terminal state ${current.status}`,
        );
      }

      // 4. Validate transition matrix
      const allowedTargets = ALLOWED_TRANSITIONS[current.status] || [];
      if (!allowedTargets.includes(targetStatus)) {
        throw new ConflictException(
          `INVALID_TRANSITION: Cannot transition shipment ${current.shipmentNumber} from ${current.status} to ${targetStatus}`,
        );
      }

      // 5. Fetch shipment items for inventory or delivery evaluation
      const shipmentItems = await tx.shipmentItem.findMany({
        where: { shipmentId },
      });

      const now = new Date();
      const eventTime = input.eventTimestamp ? new Date(input.eventTimestamp) : now;

      // 6. Handle specific target state requirements
      let packedAt = current.packedAt;
      let shippedAt = current.shippedAt;
      let outForDeliveryAt = current.outForDeliveryAt;
      let deliveredAt = current.deliveredAt;
      const trackingNumber = input.trackingNumber || current.trackingNumber;

      if (targetStatus === ShipmentStatus.PACKED && !packedAt) {
        packedAt = eventTime;
      }

      if (targetStatus === ShipmentStatus.SHIPPED) {
        if (!shippedAt) shippedAt = eventTime;

        // Perform physical inventory deduction through InventoryService
        await this.inventoryService.shipShipmentInventory(
          {
            shipmentId: current.id,
            orderId: current.orderId,
            items: shipmentItems.map((si) => ({
              variantId: si.variantId,
              quantity: si.quantity,
            })),
            actorId: actor.id,
          },
          tx,
        );

        // Check if all order items are now shipped -> advance Order to SHIPPED
        await this.evaluateOrderShipped(current.orderId, actor, tx);
      }

      if (targetStatus === ShipmentStatus.OUT_FOR_DELIVERY && !outForDeliveryAt) {
        outForDeliveryAt = eventTime;
      }

      if (targetStatus === ShipmentStatus.DELIVERED) {
        deliveredAt = eventTime;
      }

      // 7. Update shipment atomically
      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          status: targetStatus,
          previousStatus: current.status,
          packedAt,
          shippedAt,
          outForDeliveryAt,
          deliveredAt,
          trackingNumber,
          lastEventTimestamp: eventTime,
          version: { increment: 1 },
        },
        include: {
          items: true,
          events: true,
        },
      });

      // 8. Append ShipmentEvent (telemetry/history)
      await tx.shipmentEvent.create({
        data: {
          shipmentId: current.id,
          status: targetStatus,
          statusCode: input.statusCode,
          description:
            input.description ||
            input.reason ||
            `Shipment status transitioned to ${targetStatus}`,
          location: input.location,
          eventTimestamp: eventTime,
        },
      });

      // 9. Write administrative AuditLog
      const auditAction =
        targetStatus === ShipmentStatus.SHIPPED
          ? AuditAction.SHIPMENT_DISPATCHED
          : targetStatus === ShipmentStatus.DELIVERED
            ? AuditAction.SHIPMENT_DELIVERED
            : AuditAction.SHIPMENT_STATUS_CHANGED;

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          actorEmail: actor.email,
          action: auditAction,
          entityType: AuditEntityType.SHIPMENT,
          entityId: current.id,
          orderId: current.orderId,
          userId: current.userId,
          previousValue: JSON.stringify({ status: current.status }),
          newValue: JSON.stringify({ status: targetStatus }),
          reason: input.reason || `Status updated to ${targetStatus}`,
          metadata: {
            shipmentNumber: current.shipmentNumber,
            previousStatus: current.status,
            targetStatus,
          },
        },
      });

      // 10. If dispatched, evaluate Order shipped completeness
      if (targetStatus === ShipmentStatus.SHIPPED) {
        await this.evaluateOrderShipped(current.orderId, actor, tx);
      }

      // 11. If delivered, evaluate Order delivery completeness
      if (targetStatus === ShipmentStatus.DELIVERED) {
        await this.evaluateOrderDelivery(current.orderId, actor, tx);
      }

      // 12. Trigger In-App Notification (Phase 14D)
      await this.emitShipmentNotification(
        targetStatus,
        {
          id: current.id,
          shipmentNumber: current.shipmentNumber,
          orderId: current.orderId,
          userId: current.userId,
          carrierName: current.carrierName,
          trackingNumber,
        },
        tx,
        input.reason || input.description,
      );

      this.logger.log(
        `[SHIPMENT] Transitioned ${current.shipmentNumber} from ${current.status} to ${targetStatus}`,
      );

      // Re-fetch to include newest event
      const finalShipment = await tx.shipment.findUnique({
        where: { id: shipmentId },
        include: { items: true, events: true },
      });

      return this.mapToDto(finalShipment!);
    });
  }

  // ---------------------------------------------------------------------------
  // 3. PRE-DISPATCH CANCELLATION
  // ---------------------------------------------------------------------------

  /**
   * Cancels an unshipped shipment before dispatch.
   *
   * Invariants:
   * - Allowed strictly before SHIPPED (CREATED, PACKING, PACKED, READY_TO_SHIP).
   * - If already CANCELLED: returns existing record idempotently.
   * - If SHIPPED or later: strictly throws BadRequestException.
   * - Unallocated items are returned to the order's unfulfilled pool for re-packing.
   * - Appends CANCELLED ShipmentEvent and writes AuditLog.
   */
  async cancelShipment(
    shipmentId: string,
    actor: MinimalUser,
    input: CancelShipmentDto,
  ): Promise<ShipmentDto> {
    await this.assertPermission(actor, Permissions.SHIPPING_CANCEL);

    const reason = input.reason?.trim();
    if (!reason || reason.length < 3) {
      throw new BadRequestException('Cancellation reason must be at least 3 characters');
    }

    return await this.prisma.$transaction(async (tx) => {
      // 1. Establish deterministic lock hierarchy: orders -> shipments
      const meta = await tx.shipment.findUnique({
        where: { id: shipmentId },
        select: { id: true, orderId: true },
      });
      if (!meta) {
        throw new NotFoundException(`Shipment ${shipmentId} not found`);
      }

      await tx.$queryRaw`
        SELECT id FROM orders WHERE id = ${meta.orderId} FOR UPDATE
      `;

      // 2. Lock shipment row
      const shipmentRows = await tx.$queryRaw<Array<{
        id: string;
        shipmentNumber: string;
        orderId: string;
        userId: string;
        status: ShipmentStatus;
        version: number;
      }>>`
        SELECT id, "shipmentNumber", "orderId", "userId", status, version
        FROM shipments
        WHERE id = ${shipmentId}
        FOR UPDATE
      `;

      if (shipmentRows.length === 0) {
        throw new NotFoundException(`Shipment ${shipmentId} not found`);
      }
      const current = shipmentRows[0];

      // Idempotency: if already cancelled, return cleanly
      if (current.status === ShipmentStatus.CANCELLED) {
        const fullShipment = await tx.shipment.findUnique({
          where: { id: shipmentId },
          include: { items: true, events: true },
        });
        return this.mapToDto(fullShipment!);
      }

      // Pre-dispatch check
      if (!PRE_DISPATCH_STATUSES.has(current.status)) {
        throw new BadRequestException(
          `Cannot cancel shipment that has already reached status ${current.status}. Post-dispatch parcels must follow returns or carrier RTO procedure.`,
        );
      }

      const now = new Date();

      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          status: ShipmentStatus.CANCELLED,
          previousStatus: current.status,
          cancelledAt: now,
          cancelReason: reason,
          version: { increment: 1 },
        },
        include: {
          items: true,
          events: true,
        },
      });

      await tx.shipmentEvent.create({
        data: {
          shipmentId: current.id,
          status: ShipmentStatus.CANCELLED,
          description: `Shipment cancelled: ${reason}`,
          eventTimestamp: now,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          actorEmail: actor.email,
          action: AuditAction.SHIPMENT_CANCELLED,
          entityType: AuditEntityType.SHIPMENT,
          entityId: current.id,
          orderId: current.orderId,
          userId: current.userId,
          previousValue: JSON.stringify({ status: current.status }),
          newValue: JSON.stringify({ status: ShipmentStatus.CANCELLED, cancelReason: reason }),
          reason,
          metadata: {
            shipmentNumber: current.shipmentNumber,
            previousStatus: current.status,
          },
        },
      });

      this.logger.log(
        `[SHIPMENT] Cancelled shipment ${current.shipmentNumber} by ${actor.role}(${actor.id}): ${reason}`,
      );

      const finalShipment = await tx.shipment.findUnique({
        where: { id: shipmentId },
        include: { items: true, events: true },
      });

      return this.mapToDto(finalShipment!);
    });
  }

  // ---------------------------------------------------------------------------
  // 4. ORDER FULFILLMENT EVALUATION HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Evaluates if an Order has become fully SHIPPED.
   * If 100% of order items are in shipments with status >= SHIPPED, Order moves to SHIPPED.
   */
  private async evaluateOrderShipped(
    orderId: string,
    actor: MinimalUser,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order || order.status === OrderStatus.CANCELLED || order.status === OrderStatus.DELIVERED) {
      return;
    }

    // Get all items in active shipments with status >= SHIPPED
    const shippedShipmentItems: Array<{
      orderItemId: string;
      shippedQty: number;
    }> = await tx.$queryRaw`
      SELECT si."orderItemId", COALESCE(SUM(si.quantity), 0)::int as "shippedQty"
      FROM shipment_items si
      JOIN shipments s ON s.id = si."shipmentId"
      WHERE s."orderId" = ${orderId}
        AND s.status IN ('SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED')
      GROUP BY si."orderItemId"
    `;

    const shippedMap = new Map<string, number>(
      shippedShipmentItems.map((s) => [s.orderItemId, s.shippedQty]),
    );

    const isFullyShipped = order.items.every((item) => {
      const shipped = shippedMap.get(item.id) || 0;
      return shipped >= item.quantity;
    });

    if (isFullyShipped && order.status !== OrderStatus.SHIPPED) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.SHIPPED,
          updatedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          actorEmail: actor.email,
          action: AuditAction.ORDER_STATUS_CHANGED,
          entityType: AuditEntityType.ORDER,
          entityId: order.id,
          orderId: order.id,
          userId: order.userId,
          previousValue: JSON.stringify({ status: order.status }),
          newValue: JSON.stringify({ status: OrderStatus.SHIPPED }),
          reason: 'All order line items have been dispatched in shipments',
          metadata: { orderNumber: order.orderNumber },
        },
      });

      this.logger.log(
        `[ORDER] Order ${order.orderNumber} transitioned to SHIPPED (100% items dispatched)`,
      );
    }
  }

  /**
   * Evaluates if an Order has become fully DELIVERED.
   *
   * Exact Rules from Phase 13A:
   * 1. Every OrderItem must be accounted for across active shipments.
   * 2. Every active shipment for this order must have status === DELIVERED.
   * 3. If any active shipment is still in transit / failed, Order CANNOT transition to DELIVERED.
   * 4. When all shipments reach DELIVERED:
   *    - Order.status transitions to DELIVERED.
   *    - Order.deliveredAt is stamped with MAX(Shipment.deliveredAt across all shipments).
   *    - Never overwrite an existing Order.deliveredAt.
   */
  async evaluateOrderDelivery(
    orderId: string,
    actor: MinimalUser,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order || order.status === OrderStatus.CANCELLED || order.status === OrderStatus.DELIVERED) {
      return false;
    }

    // 1. Fetch all active shipments for this order
    const activeShipments = await tx.shipment.findMany({
      where: {
        orderId,
        status: { not: ShipmentStatus.CANCELLED },
      },
      include: {
        items: true,
      },
    });

    if (activeShipments.length === 0) {
      return false;
    }

    // 2. Check if ANY active shipment is not DELIVERED
    const hasUndeliveredShipment = activeShipments.some(
      (s) => s.status !== ShipmentStatus.DELIVERED,
    );
    if (hasUndeliveredShipment) {
      return false; // Partial delivery: order remains SHIPPED or PROCESSING
    }

    // 3. Verify total quantity delivered matches total order items
    const deliveredItemMap = new Map<string, number>();
    for (const shp of activeShipments) {
      for (const item of shp.items) {
        const cur = deliveredItemMap.get(item.orderItemId) || 0;
        deliveredItemMap.set(item.orderItemId, cur + item.quantity);
      }
    }

    const allItemsDelivered = order.items.every((item) => {
      const delivered = deliveredItemMap.get(item.id) || 0;
      return delivered >= item.quantity;
    });

    if (!allItemsDelivered) {
      return false;
    }

    // 4. Calculate authoritative deliveredAt timestamp: MAX(shipment.deliveredAt)
    const deliveryDates = activeShipments
      .map((s) => s.deliveredAt)
      .filter((d): d is Date => d instanceof Date);

    const maxDeliveredAt =
      deliveryDates.length > 0
        ? new Date(Math.max(...deliveryDates.map((d) => d.getTime())))
        : new Date();

    // 5. Update Order to DELIVERED atomically
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.DELIVERED,
        deliveredAt: order.deliveredAt || maxDeliveredAt,
        updatedAt: new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        actorEmail: actor.email,
        action: AuditAction.ORDER_STATUS_CHANGED,
        entityType: AuditEntityType.ORDER,
        entityId: order.id,
        orderId: order.id,
        userId: order.userId,
        previousValue: JSON.stringify({ status: order.status }),
        newValue: JSON.stringify({
          status: OrderStatus.DELIVERED,
          deliveredAt: maxDeliveredAt.toISOString(),
        }),
        reason: 'All order shipments have been successfully delivered',
        metadata: {
          orderNumber: order.orderNumber,
          shipmentsCount: activeShipments.length,
          deliveredAt: maxDeliveredAt.toISOString(),
        },
      },
    });

    this.logger.log(
      `[ORDER] Order ${order.orderNumber} successfully marked DELIVERED with deliveredAt ${maxDeliveredAt.toISOString()}`,
    );

    return true;
  }

  // ---------------------------------------------------------------------------
  // 5. QUERY & INSPECTION
  // ---------------------------------------------------------------------------

  /**
   * Retrieves a shipment by ID with IDOR protection.
   */
  async getShipment(shipmentId: string, actor: MinimalUser): Promise<ShipmentDto> {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: {
        items: true,
        events: {
          orderBy: { eventTimestamp: 'asc' },
        },
      },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${shipmentId} not found`);
    }

    // IDOR protection: User role can only access their own shipments
    if (actor.role === UserRole.USER && shipment.userId !== actor.id) {
      throw new ForbiddenException('You do not have access to this shipment');
    }

    return this.mapToDto(shipment);
  }

  /**
   * Lists all shipments for an order.
   */
  async listShipmentsByOrderId(
    orderId: string,
    actor: MinimalUser,
  ): Promise<ShipmentDto[]> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (actor.role === UserRole.USER && order.userId !== actor.id) {
      throw new ForbiddenException('You do not have access to this order');
    }

    const shipments = await this.prisma.shipment.findMany({
      where: { orderId },
      include: {
        items: true,
        events: {
          orderBy: { eventTimestamp: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return shipments.map((s) => this.mapToDto(s));
  }

  /**
   * Administrative shipment search and filtering.
   */
  async adminListShipments(
    query: AdminListShipmentsQueryDto,
    actor: MinimalUser,
  ): Promise<{
    items: ShipmentDto[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    await this.assertPermission(actor, Permissions.SHIPPING_VIEW);

    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.ShipmentWhereInput = {};

    if (query.status) {
      where.status = query.status;
    }
    if (query.carrierCode) {
      where.carrierCode = query.carrierCode;
    }
    if (query.trackingNumber) {
      where.trackingNumber = { contains: query.trackingNumber, mode: 'insensitive' };
    }
    if (query.orderId) {
      where.orderId = query.orderId;
    }
    if (query.search) {
      where.OR = [
        { shipmentNumber: { contains: query.search, mode: 'insensitive' } },
        { trackingNumber: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [shipments, total] = await Promise.all([
      this.prisma.shipment.findMany({
        where,
        include: {
          items: true,
          events: {
            orderBy: { eventTimestamp: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.shipment.count({ where }),
    ]);

    return {
      items: shipments.map((s) => this.mapToDto(s)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ---------------------------------------------------------------------------
  // 6. WEBHOOK INGRESS & RECONCILIATION INTEGRATION
  // ---------------------------------------------------------------------------

  /**
   * Looks up a shipment by tracking number or provider reference.
   */
  async findShipmentByTrackingOrProviderId(
    trackingNumber?: string | null,
    providerShipmentId?: string | null,
  ): Promise<ShipmentDto | null> {
    if (!trackingNumber && !providerShipmentId) {
      return null;
    }

    const where: Prisma.ShipmentWhereInput = {
      OR: [
        ...(trackingNumber ? [{ trackingNumber }] : []),
        ...(providerShipmentId ? [{ providerShipmentId }] : []),
      ],
    };

    const shipment = await this.prisma.shipment.findFirst({
      where,
      include: { items: true, events: true },
    });

    return shipment ? this.mapToDto(shipment) : null;
  }

  /**
   * Applies an inbound carrier webhook status event to a shipment.
   * Authority: PROVIDER_WEBHOOK.
   *
   * Executes inside an interactive transaction with row-level locks on orders and shipments.
   * Implements Scenarios A through J from Phase 13A Architecture:
   * - Monotonicity: Stale events (timestamp < lastEventTimestamp) cannot regress state.
   * - Replays/Duplicates: Returns clean no-op.
   * - Terminal Protection: Rejects changes to terminal states, flags reconciliationRequired.
   * - Out-of-order forward leaps: Allowed forward transitions (e.g. SHIPPED -> OUT_FOR_DELIVERY).
   * - Early DELIVERED: Reconciles dispatch if valid proof exists; else flags reconciliationRequired.
   * - Unknown provider status: Appends ShipmentEvent, flags reconciliationRequired, does not mutate status.
   * - RTO_DELIVERED: Does NOT auto-restock inventory.
   * - LOST: Does NOT auto-refund or mutate inventory.
   */
  async applyWebhookTransition(params: {
    shipmentId: string;
    event: NormalizedShipmentEvent;
  }): Promise<{ outcome: string; shipment: ShipmentDto }> {
    const { shipmentId, event } = params;

    return await this.prisma.$transaction(async (tx) => {
      // 1. Establish deterministic lock hierarchy: orders -> shipments
      const meta = await tx.shipment.findUnique({
        where: { id: shipmentId },
        select: { id: true, orderId: true },
      });
      if (!meta) {
        throw new NotFoundException(`Shipment ${shipmentId} not found`);
      }

      await tx.$queryRaw`
        SELECT id FROM orders WHERE id = ${meta.orderId} FOR UPDATE
      `;

      const shipmentRows = await tx.$queryRaw<Array<ShipmentRow>>`
        SELECT *
        FROM shipments
        WHERE id = ${shipmentId}
        FOR UPDATE
      `;
      if (shipmentRows.length === 0) {
        throw new NotFoundException(`Shipment ${shipmentId} not found`);
      }
      const current = shipmentRows[0];

      const targetStatus = event.canonicalStatus;

      // ── SCENARIO J / UNKNOWN STATUS: Unrecognized provider status ─────────
      if (!targetStatus) {
        this.logger.warn(
          `[WEBHOOK] Unrecognized provider status '${event.providerStatus}' for shipment ${current.shipmentNumber}. Flagging for reconciliation.`,
        );

        await tx.shipmentEvent.create({
          data: {
            shipmentId: current.id,
            status: current.status,
            statusCode: event.providerStatus,
            description: `Unknown provider status received: ${event.providerStatus}`,
            location: event.location,
            eventTimestamp: event.eventTimestamp,
            rawPayload: event.rawPayload as Prisma.InputJsonValue,
          },
        });

        await tx.shipment.update({
          where: { id: current.id },
          data: {
            reconciliationRequired: true,
            reconciliationNotes: `Unrecognized provider status received: ${event.providerStatus}`,
            lastEventTimestamp: event.eventTimestamp,
          },
        });

        const updated = await tx.shipment.findUnique({
          where: { id: shipmentId },
          include: { items: true, events: true },
        });
        return {
          outcome: 'UNKNOWN_STATUS_FLAGGED_FOR_RECONCILIATION',
          shipment: this.mapToDto(updated!),
        };
      }

      // ── SCENARIO E / TERMINAL STATE CONFLICT: Terminal state protection ───
      if (TERMINAL_STATUSES.has(current.status)) {
        if (current.status === targetStatus) {
          // Replay of same terminal event
          await tx.shipmentEvent.create({
            data: {
              shipmentId: current.id,
              status: current.status,
              statusCode: event.providerStatus,
              description: `Replay event for terminal state ${current.status}`,
              location: event.location,
              eventTimestamp: event.eventTimestamp,
              rawPayload: event.rawPayload as Prisma.InputJsonValue,
            },
          });
          const updated = await tx.shipment.findUnique({
            where: { id: shipmentId },
            include: { items: true, events: true },
          });
          return {
            outcome: 'TERMINAL_STATE_REPLAY_IGNORED',
            shipment: this.mapToDto(updated!),
          };
        }

        // Terminal state conflict / impossible transition
        this.logger.warn(
          `[WEBHOOK] Impossible event '${targetStatus}' received for terminal shipment ${current.shipmentNumber} (current: ${current.status}). Flagging reconciliation.`,
        );

        await tx.shipmentEvent.create({
          data: {
            shipmentId: current.id,
            status: current.status,
            statusCode: event.providerStatus,
            description: `Conflicting event '${targetStatus}' received for terminal shipment in status ${current.status}`,
            location: event.location,
            eventTimestamp: event.eventTimestamp,
            rawPayload: event.rawPayload as Prisma.InputJsonValue,
          },
        });

        await tx.shipment.update({
          where: { id: current.id },
          data: {
            reconciliationRequired: true,
            reconciliationNotes: `Conflicting event '${targetStatus}' received for terminal shipment in status ${current.status}`,
            lastEventTimestamp: event.eventTimestamp,
          },
        });

        await tx.auditLog.create({
          data: {
            actorId: current.userId,
            actorRole: 'SYSTEM',
            actorEmail: 'system@vishkaraa.internal',
            action: AuditAction.SHIPMENT_RECONCILIATION_REQUIRED,
            entityType: AuditEntityType.SHIPMENT,
            entityId: current.id,
            orderId: current.orderId,
            userId: current.userId,
            reason: `Conflicting webhook event for terminal shipment (${current.status} vs ${targetStatus})`,
            metadata: {
              shipmentNumber: current.shipmentNumber,
              currentStatus: current.status,
              targetStatus,
              provider: event.provider,
              eventId: event.eventId,
            },
          },
        });

        const updated = await tx.shipment.findUnique({
          where: { id: shipmentId },
          include: { items: true, events: true },
        });
        return {
          outcome: 'TERMINAL_CONFLICT_FLAGGED_FOR_RECONCILIATION',
          shipment: this.mapToDto(updated!),
        };
      }

      // ── SCENARIO C: Stale Event Protection (Monotonicity) ─────────────────
      if (current.lastEventTimestamp && event.eventTimestamp < current.lastEventTimestamp) {
        this.logger.log(
          `[WEBHOOK] Stale event '${targetStatus}' (timestamp: ${event.eventTimestamp.toISOString()}) received for shipment ${current.shipmentNumber} (lastEvent: ${current.lastEventTimestamp.toISOString()}). Appending with isStale: true without status mutation.`,
        );

        await tx.shipmentEvent.create({
          data: {
            shipmentId: current.id,
            status: current.status,
            statusCode: event.providerStatus,
            description: `Stale event received: ${event.providerStatus} timestamped prior to last known event`,
            location: event.location,
            eventTimestamp: event.eventTimestamp,
            isStale: true,
            rawPayload: event.rawPayload as Prisma.InputJsonValue,
          },
        });

        const updated = await tx.shipment.findUnique({
          where: { id: shipmentId },
          include: { items: true, events: true },
        });
        return {
          outcome: 'STALE_EVENT_IGNORED',
          shipment: this.mapToDto(updated!),
        };
      }

      // ── SCENARIO B: Same Event Replay ─────────────────────────────────────
      if (current.status === targetStatus) {
        this.logger.log(
          `[WEBHOOK] Replay event: shipment ${current.shipmentNumber} is already in status ${targetStatus}`,
        );

        await tx.shipmentEvent.create({
          data: {
            shipmentId: current.id,
            status: current.status,
            statusCode: event.providerStatus,
            description: event.statusDescription || `Replay event: shipment already in status ${targetStatus}`,
            location: event.location,
            eventTimestamp: event.eventTimestamp,
            rawPayload: event.rawPayload as Prisma.InputJsonValue,
          },
        });

        await tx.shipment.update({
          where: { id: current.id },
          data: { lastEventTimestamp: event.eventTimestamp },
        });

        const updated = await tx.shipment.findUnique({
          where: { id: shipmentId },
          include: { items: true, events: true },
        });
        return {
          outcome: 'REPLAY_EVENT_RECORDED',
          shipment: this.mapToDto(updated!),
        };
      }

      // ── SCENARIO F: Early DELIVERED before local SHIPPED ───────────────────
      if (targetStatus === ShipmentStatus.DELIVERED && PRE_DISPATCH_STATUSES.has(current.status)) {
        const hasValidDispatchEvidence = Boolean(event.hasPhysicalDispatchEvidence === true);

        if (!hasValidDispatchEvidence) {
          this.logger.warn(
            `[WEBHOOK] Carrier reported DELIVERED for pre-dispatch shipment ${current.shipmentNumber}, but missing trusted physical dispatch evidence. Flagging for reconciliation.`,
          );

          await tx.shipment.update({
            where: { id: current.id },
            data: {
              reconciliationRequired: true,
              reconciliationNotes: `Carrier reported DELIVERED for pre-dispatch shipment without verified physical dispatch evidence (requires explicit PICKED_UP/HANDOVER/DISPATCHED proof)`,
              lastEventTimestamp: event.eventTimestamp,
            },
          });

          await tx.shipmentEvent.create({
            data: {
              shipmentId: current.id,
              status: current.status,
              statusCode: event.providerStatus,
              description:
                'Early DELIVERED reported by carrier without verified physical dispatch evidence',
              location: event.location,
              eventTimestamp: event.eventTimestamp,
              rawPayload: event.rawPayload as Prisma.InputJsonValue,
            },
          });

          await tx.auditLog.create({
            data: {
              actorId: current.userId,
              actorRole: 'SYSTEM',
              actorEmail: 'system@vishkaraa.internal',
              action: AuditAction.SHIPMENT_RECONCILIATION_REQUIRED,
              entityType: AuditEntityType.SHIPMENT,
              entityId: current.id,
              orderId: current.orderId,
              userId: current.userId,
              reason: 'Early DELIVERED event without verified physical dispatch evidence',
              metadata: {
                shipmentNumber: current.shipmentNumber,
                currentStatus: current.status,
                provider: event.provider,
                eventId: event.eventId,
                trackingNumber: event.trackingNumber,
              },
            },
          });

          const updated = await tx.shipment.findUnique({
            where: { id: shipmentId },
            include: { items: true, events: true },
          });
          return {
            outcome: 'AMBIGUOUS_DISPATCH_FLAGGED_FOR_RECONCILIATION',
            shipment: this.mapToDto(updated!),
          };
        }

        // Auto-reconciliation with valid dispatch proof:
        this.logger.log(
          `[WEBHOOK] Auto-reconciling early DELIVERED for shipment ${current.shipmentNumber}: verified dispatch milestone '${event.dispatchMilestone}', deducting inventory and completing delivery`,
        );

        const shipmentItems = await tx.shipmentItem.findMany({ where: { shipmentId } });

        // Step 1: Physical inventory deduction
        await this.inventoryService.shipShipmentInventory(
          {
            shipmentId: current.id,
            orderId: current.orderId,
            items: shipmentItems.map((si) => ({
              variantId: si.variantId,
              quantity: si.quantity,
            })),
            actorId: current.userId,
          },
          tx,
        );

        // Step 2: Update status directly to DELIVERED with timestamps
        await tx.shipment.update({
          where: { id: current.id },
          data: {
            status: ShipmentStatus.DELIVERED,
            previousStatus: current.status,
            shippedAt: current.shippedAt || event.eventTimestamp,
            deliveredAt: event.eventTimestamp,
            trackingNumber: event.trackingNumber || current.trackingNumber,
            lastEventTimestamp: event.eventTimestamp,
            version: { increment: 1 },
          },
        });

        // Step 3: Append ShipmentEvent
        await tx.shipmentEvent.create({
          data: {
            shipmentId: current.id,
            status: ShipmentStatus.DELIVERED,
            statusCode: event.providerStatus,
            description: `Auto-reconciled early delivery from carrier webhook`,
            location: event.location,
            eventTimestamp: event.eventTimestamp,
            rawPayload: event.rawPayload as Prisma.InputJsonValue,
          },
        });

        // Step 4: Write AuditLog
        const systemActor: MinimalUser = {
          id: current.userId,
          role: UserRole.ADMIN,
          email: 'system@vishkaraa.internal',
        };

        await tx.auditLog.create({
          data: {
            actorId: current.userId,
            actorRole: 'SYSTEM',
            actorEmail: 'system@vishkaraa.internal',
            action: AuditAction.SHIPMENT_RECONCILED,
            entityType: AuditEntityType.SHIPMENT,
            entityId: current.id,
            orderId: current.orderId,
            userId: current.userId,
            previousValue: JSON.stringify({ status: current.status }),
            newValue: JSON.stringify({ status: ShipmentStatus.DELIVERED }),
            reason: 'Auto-reconciled early delivery from verified carrier webhook',
            metadata: {
              shipmentNumber: current.shipmentNumber,
              provider: event.provider,
              eventId: event.eventId,
            },
          },
        });

        // Step 5: Evaluate Order completeness
        await this.evaluateOrderShipped(current.orderId, systemActor, tx);
        await this.evaluateOrderDelivery(current.orderId, systemActor, tx);

        const updated = await tx.shipment.findUnique({
          where: { id: shipmentId },
          include: { items: true, events: true },
        });
        return {
          outcome: 'EARLY_DELIVERY_AUTO_RECONCILED',
          shipment: this.mapToDto(updated!),
        };
      }

      // ── SCENARIO D & VALID FORWARD TRANSITIONS ────────────────────────────
      const allowedTargets = WEBHOOK_ALLOWED_TRANSITIONS[current.status] || [];
      if (!allowedTargets.includes(targetStatus)) {
        this.logger.warn(
          `[WEBHOOK] Impossible transition '${current.status}' -> '${targetStatus}' for shipment ${current.shipmentNumber}. Flagging for reconciliation.`,
        );

        await tx.shipmentEvent.create({
          data: {
            shipmentId: current.id,
            status: current.status,
            statusCode: event.providerStatus,
            description: `Impossible transition: Cannot move from ${current.status} to ${targetStatus}`,
            location: event.location,
            eventTimestamp: event.eventTimestamp,
            rawPayload: event.rawPayload as Prisma.InputJsonValue,
          },
        });

        await tx.shipment.update({
          where: { id: current.id },
          data: {
            reconciliationRequired: true,
            reconciliationNotes: `Impossible transition received: Cannot move from ${current.status} to ${targetStatus}`,
            lastEventTimestamp: event.eventTimestamp,
          },
        });

        await tx.auditLog.create({
          data: {
            actorId: current.userId,
            actorRole: 'SYSTEM',
            actorEmail: 'system@vishkaraa.internal',
            action: AuditAction.SHIPMENT_RECONCILIATION_REQUIRED,
            entityType: AuditEntityType.SHIPMENT,
            entityId: current.id,
            orderId: current.orderId,
            userId: current.userId,
            reason: `Impossible webhook transition: ${current.status} -> ${targetStatus}`,
            metadata: {
              shipmentNumber: current.shipmentNumber,
              currentStatus: current.status,
              targetStatus,
            },
          },
        });

        const updated = await tx.shipment.findUnique({
          where: { id: shipmentId },
          include: { items: true, events: true },
        });
        return {
          outcome: 'IMPOSSIBLE_TRANSITION_FLAGGED_FOR_RECONCILIATION',
          shipment: this.mapToDto(updated!),
        };
      }

      // Allowed forward transition:
      const shipmentItems = await tx.shipmentItem.findMany({ where: { shipmentId } });

      const packedAt = current.packedAt;
      let shippedAt = current.shippedAt;
      let outForDeliveryAt = current.outForDeliveryAt;
      let deliveredAt = current.deliveredAt;
      const trackingNumber = event.trackingNumber || current.trackingNumber;

      const systemActor: MinimalUser = {
        id: current.userId,
        role: UserRole.ADMIN,
        email: 'system@vishkaraa.internal',
      };

      if (targetStatus === ShipmentStatus.SHIPPED) {
        if (!shippedAt) shippedAt = event.eventTimestamp;
        // Inventory physical deduction
        await this.inventoryService.shipShipmentInventory(
          {
            shipmentId: current.id,
            orderId: current.orderId,
            items: shipmentItems.map((si) => ({
              variantId: si.variantId,
              quantity: si.quantity,
            })),
            actorId: current.userId,
          },
          tx,
        );
        await this.evaluateOrderShipped(current.orderId, systemActor, tx);
      }

      if (targetStatus === ShipmentStatus.OUT_FOR_DELIVERY && !outForDeliveryAt) {
        outForDeliveryAt = event.eventTimestamp;
      }

      if (targetStatus === ShipmentStatus.DELIVERED) {
        deliveredAt = event.eventTimestamp;
      }

      let reconciliationNotes = current.reconciliationNotes;
      if (targetStatus === ShipmentStatus.RTO_DELIVERED) {
        // STRICT INVARIANT: No auto-restock!
        reconciliationNotes = 'RTO delivered at dock. Awaiting physical warehouse inspection scan in quarantine.';
      }

      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          status: targetStatus,
          previousStatus: current.status,
          packedAt,
          shippedAt,
          outForDeliveryAt,
          deliveredAt,
          trackingNumber,
          reconciliationNotes,
          lastEventTimestamp: event.eventTimestamp,
          version: { increment: 1 },
        },
      });

      await tx.shipmentEvent.create({
        data: {
          shipmentId: current.id,
          status: targetStatus,
          statusCode: event.providerStatus,
          description: event.statusDescription || `Shipment transitioned to ${targetStatus} via provider webhook`,
          location: event.location,
          eventTimestamp: event.eventTimestamp,
          rawPayload: event.rawPayload as Prisma.InputJsonValue,
        },
      });

      const auditAction =
        targetStatus === ShipmentStatus.SHIPPED
          ? AuditAction.SHIPMENT_DISPATCHED
          : targetStatus === ShipmentStatus.DELIVERED
            ? AuditAction.SHIPMENT_DELIVERED
            : AuditAction.SHIPMENT_STATUS_CHANGED;

      await tx.auditLog.create({
        data: {
          actorId: current.userId,
          actorRole: 'SYSTEM',
          actorEmail: 'system@vishkaraa.internal',
          action: auditAction,
          entityType: AuditEntityType.SHIPMENT,
          entityId: current.id,
          orderId: current.orderId,
          userId: current.userId,
          previousValue: JSON.stringify({ status: current.status }),
          newValue: JSON.stringify({ status: targetStatus }),
          reason: `Webhook state transition to ${targetStatus}`,
          metadata: {
            shipmentNumber: current.shipmentNumber,
            previousStatus: current.status,
            targetStatus,
            provider: event.provider,
            eventId: event.eventId,
          },
        },
      });

      if (targetStatus === ShipmentStatus.DELIVERED) {
        await this.evaluateOrderDelivery(current.orderId, systemActor, tx);
      }

      // Trigger In-App Notification (Phase 14D)
      await this.emitShipmentNotification(
        targetStatus,
        {
          id: current.id,
          shipmentNumber: current.shipmentNumber,
          orderId: current.orderId,
          userId: current.userId,
          carrierName: current.carrierName,
          trackingNumber,
        },
        tx,
        event.statusDescription,
      );

      const updated = await tx.shipment.findUnique({
        where: { id: shipmentId },
        include: { items: true, events: true },
      });

      return {
        outcome: 'TRANSITION_APPLIED',
        shipment: this.mapToDto(updated!),
      };
    });
  }

  /**
   * Lists shipments requiring manual administrative reconciliation.
   */
  async listReconciliationShipments(
    query: ShippingQueryDto,
  ): Promise<{ data: ShipmentDto[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.ShipmentWhereInput = {
      reconciliationRequired: true,
      ...(query.status ? { status: query.status } : {}),
      ...(query.carrierCode ? { carrierCode: query.carrierCode } : {}),
      ...(query.search
        ? {
            OR: [
              { shipmentNumber: { contains: query.search, mode: 'insensitive' } },
              { trackingNumber: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, shipments] = await Promise.all([
      this.prisma.shipment.count({ where }),
      this.prisma.shipment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: { items: true, events: true },
      }),
    ]);

    return {
      data: shipments.map((s) => this.mapToDto(s)),
      total,
      page,
      limit,
    };
  }

  /**
   * Manually resolves an operational discrepancy on a shipment.
   * Authority: Elevated admin with Permissions.SHIPPING_RECONCILE.
   */
  async resolveReconciliation(
    shipmentId: string,
    actor: MinimalUser,
    input: ReconcileShipmentDto,
  ): Promise<ShipmentDto> {
    await this.assertPermission(actor, Permissions.SHIPPING_RECONCILE);

    return await this.prisma.$transaction(async (tx) => {
      const meta = await tx.shipment.findUnique({
        where: { id: shipmentId },
        select: { id: true, orderId: true },
      });
      if (!meta) {
        throw new NotFoundException(`Shipment ${shipmentId} not found`);
      }

      await tx.$queryRaw`
        SELECT id FROM orders WHERE id = ${meta.orderId} FOR UPDATE
      `;

      const shipmentRows = await tx.$queryRaw<Array<ShipmentRow>>`
        SELECT *
        FROM shipments
        WHERE id = ${shipmentId}
        FOR UPDATE
      `;
      if (shipmentRows.length === 0) {
        throw new NotFoundException(`Shipment ${shipmentId} not found`);
      }
      const current = shipmentRows[0];

      let targetStatus = current.status;
      let shippedAt = current.shippedAt;
      let deliveredAt = current.deliveredAt;
      const now = new Date();

      if (input.targetStatus && input.targetStatus !== current.status) {
        targetStatus = input.targetStatus;

        // Terminal state protection: terminal states can never be regressed or mutated
        if (TERMINAL_STATUSES.has(current.status)) {
          throw new ConflictException(
            `TERMINAL_STATE: Cannot transition shipment ${current.shipmentNumber} from terminal state ${current.status}`,
          );
        }

        // Validate target status against RECONCILIATION_ALLOWED_TRANSITIONS
        const allowedTargets = RECONCILIATION_ALLOWED_TRANSITIONS[current.status] || [];
        if (!allowedTargets.includes(targetStatus)) {
          throw new ConflictException(
            `INVALID_RECONCILIATION_TRANSITION: Cannot transition shipment ${current.shipmentNumber} from ${current.status} to ${targetStatus}`,
          );
        }

        // If resolving from pre-dispatch to SHIPPED or DELIVERED, inventory must be physically dispatched
        if (
          (targetStatus === ShipmentStatus.SHIPPED || targetStatus === ShipmentStatus.DELIVERED) &&
          PRE_DISPATCH_STATUSES.has(current.status)
        ) {
          const items = await tx.shipmentItem.findMany({ where: { shipmentId } });
          await this.inventoryService.shipShipmentInventory(
            {
              shipmentId: current.id,
              orderId: current.orderId,
              items: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
              actorId: actor.id,
            },
            tx,
          );
          shippedAt = current.shippedAt || now;
        }

        if (targetStatus === ShipmentStatus.DELIVERED) {
          if (!shippedAt) shippedAt = now;
          deliveredAt = current.deliveredAt || now;
        }
      }

      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          status: targetStatus,
          previousStatus: targetStatus !== current.status ? current.status : current.previousStatus,
          shippedAt,
          deliveredAt,
          reconciliationRequired: false,
          reconciliationNotes: `[Resolved by ${actor.role} ${actor.id}]: ${input.notes}`,
          updatedAt: now,
          version: { increment: 1 },
        },
      });

      if (targetStatus === ShipmentStatus.SHIPPED || targetStatus === ShipmentStatus.DELIVERED) {
        await this.evaluateOrderShipped(current.orderId, actor, tx);
      }
      if (targetStatus === ShipmentStatus.DELIVERED) {
        await this.evaluateOrderDelivery(current.orderId, actor, tx);
      }

      await tx.shipmentEvent.create({
        data: {
          shipmentId: current.id,
          status: targetStatus,
          statusCode: 'RECONCILED',
          description: `Reconciled by administrator: ${input.notes}`,
          eventTimestamp: now,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          actorEmail: actor.email,
          action: AuditAction.SHIPMENT_RECONCILED,
          entityType: AuditEntityType.SHIPMENT,
          entityId: current.id,
          orderId: current.orderId,
          userId: current.userId,
          previousValue: JSON.stringify({ status: current.status, reconciliationRequired: true }),
          newValue: JSON.stringify({ status: targetStatus, reconciliationRequired: false }),
          reason: input.notes,
          metadata: {
            shipmentNumber: current.shipmentNumber,
            previousStatus: current.status,
            targetStatus,
          },
        },
      });

      const updated = await tx.shipment.findUnique({
        where: { id: shipmentId },
        include: { items: true, events: true },
      });
      return this.mapToDto(updated!);
    });
  }

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  private async assertPermission(
    actor: MinimalUser,
    permissionKey: string,
  ): Promise<void> {
    if (actor.role === UserRole.SUPER_ADMIN) {
      return;
    }

    const allowed = await this.permissionsService.can(actor, permissionKey);
    if (!allowed) {
      throw new ForbiddenException(
        `Insufficient permissions: missing ${permissionKey}`,
      );
    }
  }

  private mapToDto(shipment: PrismaShipmentWithItemsAndEvents): ShipmentDto {
    return {
      id: shipment.id,
      shipmentNumber: shipment.shipmentNumber,
      orderId: shipment.orderId,
      userId: shipment.userId,
      status: shipment.status as unknown as ShipmentDto['status'],
      previousStatus: shipment.previousStatus as unknown as ShipmentDto['previousStatus'],
      carrierCode: shipment.carrierCode,
      carrierName: shipment.carrierName,
      serviceType: shipment.serviceType,
      trackingNumber: shipment.trackingNumber,
      providerShipmentId: shipment.providerShipmentId,
      weightGrams: shipment.weightGrams,
      lengthCm: shipment.lengthCm,
      widthCm: shipment.widthCm,
      heightCm: shipment.heightCm,
      isCod: shipment.isCod,
      codAmountPaise: shipment.codAmountPaise,
      labelUrl: shipment.labelUrl,
      manifestUrl: shipment.manifestUrl,
      invoiceId: shipment.invoiceId,
      packedAt: shipment.packedAt?.toISOString() || null,
      shippedAt: shipment.shippedAt?.toISOString() || null,
      outForDeliveryAt: shipment.outForDeliveryAt?.toISOString() || null,
      deliveredAt: shipment.deliveredAt?.toISOString() || null,
      cancelledAt: shipment.cancelledAt?.toISOString() || null,
      cancelReason: shipment.cancelReason,
      lastEventTimestamp: shipment.lastEventTimestamp?.toISOString() || null,
      version: shipment.version,
      reconciliationRequired: shipment.reconciliationRequired,
      reconciliationNotes: shipment.reconciliationNotes,
      items: shipment.items?.map((i) => ({
        id: i.id,
        shipmentId: i.shipmentId,
        orderItemId: i.orderItemId,
        variantId: i.variantId,
        productName: i.productName,
        variantName: i.variantName,
        productSku: i.productSku,
        quantity: i.quantity,
        createdAt: i.createdAt.toISOString(),
      })),
      events: shipment.events?.map((e) => ({
        id: e.id,
        shipmentId: e.shipmentId,
        status: e.status as unknown as ShipmentEventDto['status'],
        statusCode: e.statusCode,
        description: e.description,
        location: e.location,
        eventTimestamp: e.eventTimestamp.toISOString(),
        providerEventId: e.providerEventId,
        isStale: e.isStale,
        rawPayload: e.rawPayload as Record<string, unknown> | null,
        createdAt: e.createdAt.toISOString(),
      })),
      createdAt: shipment.createdAt.toISOString(),
      updatedAt: shipment.updatedAt.toISOString(),
    };
  }

  // =============================================================================
  // PHASE 13B.4: CUSTOMER SHIPMENT RETRIEVAL (OWNERSHIP & IDOR GATED)
  // =============================================================================

  /**
   * Retrieves all shipments for a customer's order.
   * Enforces server-side ownership: order must exist and belong to actor.id.
   */
  async getShipmentsForOrder(
    orderId: string,
    actor: MinimalUser,
  ): Promise<CustomerShipmentDto[]> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (
      order.userId !== actor.id &&
      actor.role !== UserRole.SUPER_ADMIN &&
      actor.role !== UserRole.ADMIN
    ) {
      throw new ForbiddenException('Access denied to this order');
    }

    const shipments = await this.prisma.shipment.findMany({
      where: { orderId },
      include: { items: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    return shipments.map((s) => this.mapToCustomerDto(s));
  }

  /**
   * Retrieves a specific shipment for a customer's order.
   * Enforces server-side ownership: order must belong to actor.id and shipment must belong to orderId.
   */
  async getShipmentForOrder(
    orderId: string,
    shipmentId: string,
    actor: MinimalUser,
  ): Promise<CustomerShipmentDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (
      order.userId !== actor.id &&
      actor.role !== UserRole.SUPER_ADMIN &&
      actor.role !== UserRole.ADMIN
    ) {
      throw new ForbiddenException('Access denied to this order');
    }

    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, orderId },
      include: { items: true },
    });

    if (!shipment) {
      throw new NotFoundException('Shipment not found');
    }

    return this.mapToCustomerDto(shipment);
  }

  // =============================================================================
  // PHASE 13B.4: ADMIN SHIPMENT RETRIEVAL (PERMISSION GATED)
  // =============================================================================

  /**
   * Lists shipments for administrators with bounded pagination and filtering.
   * Requires Permissions.SHIPPING_VIEW.
   */
  async listShipments(
    actor: MinimalUser,
    query: AdminListShipmentsQueryDto,
  ): Promise<AdminShipmentListDto> {
    await this.assertPermission(actor, Permissions.SHIPPING_VIEW);

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const carrier = query.carrierCode || query.provider;

    const where: Prisma.ShipmentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.trackingNumber ? { trackingNumber: query.trackingNumber } : {}),
      ...(carrier ? { carrierCode: carrier } : {}),
      ...(typeof query.reconciliationRequired === 'boolean'
        ? { reconciliationRequired: query.reconciliationRequired }
        : {}),
      ...(query.startDate || query.endDate
        ? {
            createdAt: {
              ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
              ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { shipmentNumber: { contains: query.search, mode: 'insensitive' } },
              { trackingNumber: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, shipments] = await Promise.all([
      this.prisma.shipment.count({ where }),
      this.prisma.shipment.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { items: true, events: true },
      }),
    ]);

    return {
      data: shipments.map((s) => this.mapToAdminDto(s)),
      total,
      page,
      limit,
    };
  }

  /**
   * Retrieves full operational shipment details for administrators.
   * Requires Permissions.SHIPPING_VIEW.
   */
  async getShipmentById(
    shipmentId: string,
    actor: MinimalUser,
  ): Promise<AdminShipmentDto> {
    await this.assertPermission(actor, Permissions.SHIPPING_VIEW);

    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: {
        items: true,
        events: {
          orderBy: { eventTimestamp: 'desc' },
        },
      },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${shipmentId} not found`);
    }

    return this.mapToAdminDto(shipment);
  }

  // =============================================================================
  // RESPONSE SHAPE MAPPERS
  // =============================================================================

  /**
   * Maps internal shipment entity to customer-safe DTO.
   * Enforces zero exposure of provider secrets, webhook payloads, internal reconciliation notes,
   * or unvalidated tracking URLs.
   */
  mapToCustomerDto(
    shipment: Prisma.ShipmentGetPayload<{ include: { items: true } }>,
  ): CustomerShipmentDto {
    const rawTrackingUrl = shipment.labelUrl;
    const isUrlSafe = rawTrackingUrl
      ? validateTrackingUrl(rawTrackingUrl, shipment.carrierCode)
      : false;

    return {
      id: shipment.id,
      shipmentNumber: shipment.shipmentNumber,
      orderId: shipment.orderId,
      status: shipment.status as unknown as CustomerShipmentDto['status'],
      carrierName: shipment.carrierName,
      serviceType: shipment.serviceType,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: isUrlSafe ? rawTrackingUrl : null,
      shippedAt: shipment.shippedAt?.toISOString() || null,
      deliveredAt: shipment.deliveredAt?.toISOString() || null,
      items: (shipment.items || []).map((i) => ({
        id: i.id,
        orderItemId: i.orderItemId,
        productName: i.productName,
        variantName: i.variantName,
        productSku: i.productSku,
        quantity: i.quantity,
      })),
      createdAt: shipment.createdAt.toISOString(),
    };
  }

  /**
   * Maps internal shipment entity to administrative operational DTO.
   * Excludes raw webhook payloads (which may contain provider secrets/credentials).
   */
  mapToAdminDto(shipment: PrismaShipmentWithItemsAndEvents): AdminShipmentDto {
    return {
      id: shipment.id,
      shipmentNumber: shipment.shipmentNumber,
      orderId: shipment.orderId,
      userId: shipment.userId,
      status: shipment.status as unknown as AdminShipmentDto['status'],
      previousStatus: shipment.previousStatus as unknown as AdminShipmentDto['previousStatus'],
      carrierCode: shipment.carrierCode,
      carrierName: shipment.carrierName,
      serviceType: shipment.serviceType,
      trackingNumber: shipment.trackingNumber,
      providerShipmentId: shipment.providerShipmentId,
      weightGrams: shipment.weightGrams,
      lengthCm: shipment.lengthCm,
      widthCm: shipment.widthCm,
      heightCm: shipment.heightCm,
      isCod: shipment.isCod,
      codAmountPaise: shipment.codAmountPaise,
      labelUrl: shipment.labelUrl,
      manifestUrl: shipment.manifestUrl,
      invoiceId: shipment.invoiceId,
      packedAt: shipment.packedAt?.toISOString() || null,
      shippedAt: shipment.shippedAt?.toISOString() || null,
      outForDeliveryAt: shipment.outForDeliveryAt?.toISOString() || null,
      deliveredAt: shipment.deliveredAt?.toISOString() || null,
      cancelledAt: shipment.cancelledAt?.toISOString() || null,
      cancelReason: shipment.cancelReason,
      lastEventTimestamp: shipment.lastEventTimestamp?.toISOString() || null,
      version: shipment.version,
      reconciliationRequired: shipment.reconciliationRequired,
      reconciliationNotes: shipment.reconciliationNotes,
      items: shipment.items?.map((i) => ({
        id: i.id,
        shipmentId: i.shipmentId,
        orderItemId: i.orderItemId,
        variantId: i.variantId,
        productName: i.productName,
        variantName: i.variantName,
        productSku: i.productSku,
        quantity: i.quantity,
        createdAt: i.createdAt.toISOString(),
      })),
      events: shipment.events?.map((e) => ({
        id: e.id,
        shipmentId: e.shipmentId,
        status: e.status as unknown as AdminShipmentDto['status'],
        statusCode: e.statusCode,
        description: e.description,
        location: e.location,
        eventTimestamp: e.eventTimestamp.toISOString(),
        providerEventId: e.providerEventId,
        isStale: e.isStale,
        createdAt: e.createdAt.toISOString(),
      })),
      createdAt: shipment.createdAt.toISOString(),
      updatedAt: shipment.updatedAt.toISOString(),
    };
  }
}
