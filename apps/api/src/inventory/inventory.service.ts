import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import {
  ReservationStatus,
  InventoryMovementType,
  Prisma,
} from '@prisma/client';
import {
  type InventoryItemDto,
  type InventoryReservationDto,
  type InventoryMovementDto,
  type ReservationStatus as SharedReservationStatus,
  type InventoryMovementType as SharedMovementType,
  AuditAction,
  AuditEntityType,
} from '@vishkaraa/types';
import { AuditService } from '../audit/audit.service.js';
import type {
  AdminListInventoryQueryDto,
  AdminListMovementsQueryDto,
} from './dto/inventory-query.dto.js';
import type { AdjustStockDto } from './dto/adjust-stock.dto.js';

export interface ReserveStockItemParam {
  variantId: string;
  quantity: number;
}

export interface ReserveStockParams {
  checkoutSessionId: string;
  items: ReserveStockItemParam[];
  expiresAt: Date;
  actorId: string;
}

export interface RestockReturnItemParams {
  returnItemId: string;
  variantId: string;
  quantity: number;
  actorId: string;
  reason?: string;
}

export interface AdjustStockParams extends AdjustStockDto {
  variantId: string;
  actorId: string;
  actorRole: string;
  actorEmail?: string;
}

export interface StockIncreaseParams {
  variantId: string;
  quantity: number;
  reason: string;
  notes?: string;
  idempotencyKey?: string;
  actorId: string;
  actorRole: string;
  actorEmail?: string;
}

export interface StockDecreaseParams {
  variantId: string;
  quantity: number;
  reason: string;
  notes?: string;
  idempotencyKey?: string;
  actorId: string;
  actorRole: string;
  actorEmail?: string;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Helper to execute a callback within an existing transaction or create a new one.
   */
  private async executeTx<T>(
    tx: Prisma.TransactionClient | undefined,
    callback: (t: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (tx) {
      return callback(tx);
    }
    return this.prisma.$transaction(
      async (newTx) => {
        return callback(newTx);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 10000,
      },
    );
  }

  /**
   * Ensures an InventoryItem row exists for a ProductVariant.
   * If missing, creates with 0 onHand, 0 reserved, 0 committed (zero fabricated stock).
   */
  async ensureInventoryItem(
    variantId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryItemDto> {
    const client = tx ?? this.prisma;
    const item = await client.inventoryItem.upsert({
      where: { variantId },
      update: {},
      create: {
        variantId,
        onHand: 0,
        reserved: 0,
        committed: 0,
        lowStockThreshold: 5,
        version: 1,
      },
      include: {
        variant: {
          select: {
            id: true,
            sku: true,
            name: true,
            productId: true,
            product: { select: { name: true } },
          },
        },
      },
    });

    return this.mapItemToDto(item);
  }

  /**
   * Retrieves live inventory balance for a variant with strictly derived availability:
   * available = onHand - reserved - committed
   */
  async getBalance(
    variantId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryItemDto> {
    const client = tx ?? this.prisma;
    const item = await client.inventoryItem.findUnique({
      where: { variantId },
      include: {
        variant: {
          select: {
            id: true,
            sku: true,
            name: true,
            productId: true,
            product: { select: { name: true } },
          },
        },
      },
    });

    if (!item) {
      return this.ensureInventoryItem(variantId, tx);
    }

    return this.mapItemToDto(item);
  }

  /**
   * Reserves stock for an active CheckoutSession.
   * Deadlock-free: sorts all variant IDs lexicographically before acquiring row locks.
   * Concurrency-safe: verifies available = onHand - reserved - committed >= requested.
   */
  async reserveStock(
    params: ReserveStockParams,
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryReservationDto[]> {
    if (!params.items || params.items.length === 0) {
      return [];
    }

    for (const item of params.items) {
      if (!item.quantity || item.quantity <= 0) {
        throw new BadRequestException(
          `Invalid reservation quantity ${item.quantity} for variant ${item.variantId}. Must be positive.`,
        );
      }
    }

    // Lexicographical sorting to prevent deadlocks across concurrent sessions
    const sortedItems = [...params.items].sort((a, b) =>
      a.variantId.localeCompare(b.variantId),
    );

    return this.executeTx(tx, async (transaction) => {
      // 1. Ensure InventoryItem exists for all variants
      for (const item of sortedItems) {
        await transaction.inventoryItem.upsert({
          where: { variantId: item.variantId },
          update: {},
          create: {
            variantId: item.variantId,
            onHand: 0,
            reserved: 0,
            committed: 0,
            lowStockThreshold: 5,
            version: 1,
          },
        });
      }

      // 2. Lock rows in deterministic sorted order via SELECT ... FOR UPDATE
      const variantIds = sortedItems.map((i) => i.variantId);
      const lockedRows: Array<{
        id: string;
        variantId: string;
        onHand: number;
        reserved: number;
        committed: number;
        version: number;
      }> = await transaction.$queryRaw`
        SELECT id, "variantId", "onHand", reserved, committed, version
        FROM inventory_items
        WHERE "variantId" IN (${Prisma.join(variantIds)})
        ORDER BY "variantId" ASC
        FOR UPDATE
      `;

      const rowMap = new Map(lockedRows.map((r) => [r.variantId, r]));

      // 3. Find existing reservations for this checkoutSession
      const existingReservations =
        await transaction.inventoryReservation.findMany({
          where: {
            checkoutSessionId: params.checkoutSessionId,
            variantId: { in: variantIds },
          },
        });

      const existingMap = new Map(
        existingReservations.map((r) => [r.variantId, r]),
      );

      const results: InventoryReservationDto[] = [];

      for (const requestedItem of sortedItems) {
        const row = rowMap.get(requestedItem.variantId);
        if (!row) {
          throw new NotFoundException(
            `Inventory item for variant ${requestedItem.variantId} could not be locked.`,
          );
        }

        const existingRes = existingMap.get(requestedItem.variantId);

        if (existingRes) {
          if (existingRes.status === ReservationStatus.COMMITTED) {
            throw new ConflictException(
              `Stock for variant ${requestedItem.variantId} in session ${params.checkoutSessionId} is already committed.`,
            );
          }

          if (existingRes.status === ReservationStatus.PENDING) {
            const qtyDelta = requestedItem.quantity - existingRes.quantity;
            if (qtyDelta === 0) {
              // Already reserved at requested quantity
              results.push(this.mapReservationToDto(existingRes));
              continue;
            }

            if (qtyDelta > 0) {
              const currentAvailable =
                row.onHand - row.reserved - row.committed;
              if (currentAvailable < qtyDelta) {
                throw new ConflictException({
                  code: 'INSUFFICIENT_STOCK',
                  message: `Insufficient stock for variant ${requestedItem.variantId}. Available: ${currentAvailable}, Requested additional: ${qtyDelta}`,
                  variantId: requestedItem.variantId,
                  available: currentAvailable,
                  requested: qtyDelta,
                });
              }

              // Update stock & reservation
              const updatedItem = await transaction.inventoryItem.update({
                where: { id: row.id },
                data: {
                  reserved: row.reserved + qtyDelta,
                  version: { increment: 1 },
                },
              });

              const updatedRes = await transaction.inventoryReservation.update({
                where: { id: existingRes.id },
                data: {
                  quantity: requestedItem.quantity,
                  expiresAt: params.expiresAt,
                },
              });

              await transaction.inventoryMovement.create({
                data: {
                  idempotencyKey: `res_expand_${existingRes.id}_${updatedItem.version}`,
                  inventoryItemId: row.id,
                  variantId: requestedItem.variantId,
                  type: InventoryMovementType.CHECKOUT_RESERVED,
                  quantityDelta: qtyDelta,
                  onHandAfter: updatedItem.onHand,
                  reservedAfter: updatedItem.reserved,
                  committedAfter: updatedItem.committed,
                  referenceType: 'CHECKOUT_SESSION',
                  referenceId: params.checkoutSessionId,
                  actorId: params.actorId,
                  reason: 'Checkout stock reservation expansion',
                },
              });

              results.push(this.mapReservationToDto(updatedRes));
              continue;
            } else {
              // Quantity decreased in cart
              const releaseQty = Math.abs(qtyDelta);
              const updatedItem = await transaction.inventoryItem.update({
                where: { id: row.id },
                data: {
                  reserved: Math.max(0, row.reserved - releaseQty),
                  version: { increment: 1 },
                },
              });

              const updatedRes = await transaction.inventoryReservation.update({
                where: { id: existingRes.id },
                data: {
                  quantity: requestedItem.quantity,
                  expiresAt: params.expiresAt,
                },
              });

              await transaction.inventoryMovement.create({
                data: {
                  idempotencyKey: `res_shrink_${existingRes.id}_${updatedItem.version}`,
                  inventoryItemId: row.id,
                  variantId: requestedItem.variantId,
                  type: InventoryMovementType.RESERVATION_RELEASED,
                  quantityDelta: -releaseQty,
                  onHandAfter: updatedItem.onHand,
                  reservedAfter: updatedItem.reserved,
                  committedAfter: updatedItem.committed,
                  referenceType: 'CHECKOUT_SESSION',
                  referenceId: params.checkoutSessionId,
                  actorId: params.actorId,
                  reason: 'Checkout stock reservation reduced',
                },
              });

              results.push(this.mapReservationToDto(updatedRes));
              continue;
            }
          }
        }

        // Fresh reservation
        const available = row.onHand - row.reserved - row.committed;
        if (available < requestedItem.quantity) {
          throw new ConflictException({
            code: 'INSUFFICIENT_STOCK',
            message: `Insufficient stock for variant ${requestedItem.variantId}. Available: ${available}, Requested: ${requestedItem.quantity}`,
            variantId: requestedItem.variantId,
            available,
            requested: requestedItem.quantity,
          });
        }

        // Atomically increment reserved count
        const updatedItem = await transaction.inventoryItem.update({
          where: { id: row.id },
          data: {
            reserved: row.reserved + requestedItem.quantity,
            version: { increment: 1 },
          },
        });

        // Update in-memory row representation for subsequent checks if duplicate variant
        row.reserved += requestedItem.quantity;

        const newReservation = await transaction.inventoryReservation.upsert({
          where: {
            checkoutSessionId_variantId: {
              checkoutSessionId: params.checkoutSessionId,
              variantId: requestedItem.variantId,
            },
          },
          update: {
            quantity: requestedItem.quantity,
            status: ReservationStatus.PENDING,
            expiresAt: params.expiresAt,
          },
          create: {
            inventoryItemId: row.id,
            variantId: requestedItem.variantId,
            checkoutSessionId: params.checkoutSessionId,
            quantity: requestedItem.quantity,
            status: ReservationStatus.PENDING,
            expiresAt: params.expiresAt,
          },
        });

        await transaction.inventoryMovement.create({
          data: {
            idempotencyKey: `res_create_${newReservation.id}`,
            inventoryItemId: row.id,
            variantId: requestedItem.variantId,
            type: InventoryMovementType.CHECKOUT_RESERVED,
            quantityDelta: requestedItem.quantity,
            onHandAfter: updatedItem.onHand,
            reservedAfter: updatedItem.reserved,
            committedAfter: updatedItem.committed,
            referenceType: 'CHECKOUT_SESSION',
            referenceId: params.checkoutSessionId,
            actorId: params.actorId,
            reason: 'Checkout stock reservation created',
          },
        });

        results.push(this.mapReservationToDto(newReservation));
      }

      return results;
    });
  }

  /**
   * Releases active reservations for a CheckoutSession (e.g. cart modified, cancelled, or superseded).
   * Idempotent: safe to call multiple times.
   */
  async releaseReservation(
    checkoutSessionId: string,
    actorId: string,
    reason?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await this.executeTx(tx, async (transaction) => {
      const pendingReservations =
        await transaction.inventoryReservation.findMany({
          where: {
            checkoutSessionId,
            status: ReservationStatus.PENDING,
          },
        });

      if (pendingReservations.length === 0) {
        return;
      }

      // Lexicographically sort variant IDs
      const sorted = [...pendingReservations].sort((a, b) =>
        a.variantId.localeCompare(b.variantId),
      );
      const variantIds = sorted.map((r) => r.variantId);

      // Lock items
      const lockedRows: Array<{
        id: string;
        variantId: string;
        onHand: number;
        reserved: number;
        committed: number;
        version: number;
      }> = await transaction.$queryRaw`
        SELECT id, "variantId", "onHand", reserved, committed, version
        FROM inventory_items
        WHERE "variantId" IN (${Prisma.join(variantIds)})
        ORDER BY "variantId" ASC
        FOR UPDATE
      `;

      const rowMap = new Map(lockedRows.map((r) => [r.variantId, r]));

      for (const res of sorted) {
        const row = rowMap.get(res.variantId);
        if (!row) continue;

        const newReserved = Math.max(0, row.reserved - res.quantity);
        const updatedItem = await transaction.inventoryItem.update({
          where: { id: row.id },
          data: {
            reserved: newReserved,
            version: { increment: 1 },
          },
        });

        await transaction.inventoryReservation.update({
          where: { id: res.id },
          data: { status: ReservationStatus.RELEASED },
        });

        await transaction.inventoryMovement.upsert({
          where: { idempotencyKey: `res_release_${res.id}` },
          update: {},
          create: {
            idempotencyKey: `res_release_${res.id}`,
            inventoryItemId: row.id,
            variantId: res.variantId,
            type: InventoryMovementType.RESERVATION_RELEASED,
            quantityDelta: -res.quantity,
            onHandAfter: updatedItem.onHand,
            reservedAfter: updatedItem.reserved,
            committedAfter: updatedItem.committed,
            referenceType: 'CHECKOUT_SESSION',
            referenceId: checkoutSessionId,
            actorId,
            reason: reason || 'Checkout session released or cancelled',
          },
        });
      }
    });
  }

  /**
   * Commits reserved stock to an Order during atomic finalization.
   * MUST be executed inside the same transaction as Order creation!
   * Transitions reserved -> committed.
   */
  async commitReservation(
    checkoutSessionId: string,
    orderId: string,
    actorId: string,
    tx: Prisma.TransactionClient,
  ): Promise<InventoryReservationDto[]> {
    // 1. Initial lookup to get variant IDs for ordering
    const initialReservations = await tx.inventoryReservation.findMany({
      where: { checkoutSessionId },
    });

    if (initialReservations.length === 0) {
      throw new BadRequestException(
        `No stock reservations found for checkout session '${checkoutSessionId}'.`,
      );
    }

    // Check if already committed to this order (idempotent fast-path)
    const allAlreadyCommitted = initialReservations.every(
      (r) => r.status === ReservationStatus.COMMITTED && r.orderId === orderId,
    );
    if (allAlreadyCommitted) {
      return initialReservations.map((r) => this.mapReservationToDto(r));
    }

    // Lexicographically sort variant IDs
    const sortedVariantIds = [
      ...new Set(initialReservations.map((r) => r.variantId)),
    ].sort();

    // 2. TWO-ENTITY LOCK HIERARCHY:
    // Step 2a: Lock inventory_items FIRST (in strict lexicographical order)
    const lockedRows: Array<{
      id: string;
      variantId: string;
      onHand: number;
      reserved: number;
      committed: number;
      version: number;
    }> = await tx.$queryRaw`
      SELECT id, "variantId", "onHand", reserved, committed, version
      FROM inventory_items
      WHERE "variantId" IN (${Prisma.join(sortedVariantIds)})
      ORDER BY "variantId" ASC
      FOR UPDATE
    `;

    const rowMap = new Map(lockedRows.map((r) => [r.variantId, r]));

    // Step 2b: Lock inventory_reservations SECOND (in strict lexicographical order)
    const lockedReservations: Array<{
      id: string;
      inventoryItemId: string;
      variantId: string;
      checkoutSessionId: string;
      orderId: string | null;
      quantity: number;
      status: ReservationStatus;
      expiresAt: Date;
      createdAt: Date;
      updatedAt: Date;
    }> = await tx.$queryRaw`
      SELECT id, "inventoryItemId", "variantId", "checkoutSessionId", "orderId", quantity, status, "expiresAt", "createdAt", "updatedAt"
      FROM inventory_reservations
      WHERE "checkoutSessionId" = ${checkoutSessionId}
      ORDER BY "variantId" ASC
      FOR UPDATE
    `;

    // 3. Re-verify each reservation's status under strict lock
    const now = new Date();
    for (const res of lockedReservations) {
      if (res.status === ReservationStatus.COMMITTED && res.orderId === orderId) {
        continue;
      }
      if (res.status === ReservationStatus.COMMITTED && res.orderId !== orderId) {
        throw new ConflictException(
          `Reservation for variant ${res.variantId} was already committed to another order (${res.orderId}).`,
        );
      }
      if (
        res.status === ReservationStatus.RELEASED ||
        res.status === ReservationStatus.EXPIRED
      ) {
        throw new BadRequestException(
          `Reservation for variant ${res.variantId} cannot be committed because it is ${res.status}.`,
        );
      }
      if (res.expiresAt <= now) {
        throw new BadRequestException(
          `Reservation for variant ${res.variantId} has expired at ${res.expiresAt.toISOString()}.`,
        );
      }
    }

    const results: InventoryReservationDto[] = [];

    for (const res of lockedReservations) {
      if (res.status === ReservationStatus.COMMITTED && res.orderId === orderId) {
        results.push(this.mapReservationToDto(res));
        continue;
      }

      const row = rowMap.get(res.variantId);
      if (!row) {
        throw new NotFoundException(
          `Inventory item ${res.variantId} could not be locked for commit.`,
        );
      }

      const newReserved = Math.max(0, row.reserved - res.quantity);
      const newCommitted = row.committed + res.quantity;

      const updatedItem = await tx.inventoryItem.update({
        where: { id: row.id },
        data: {
          reserved: newReserved,
          committed: newCommitted,
          version: { increment: 1 },
        },
      });

      const updatedRes = await tx.inventoryReservation.update({
        where: { id: res.id },
        data: {
          status: ReservationStatus.COMMITTED,
          orderId,
        },
      });

      await tx.inventoryMovement.upsert({
        where: { idempotencyKey: `ord_commit_${orderId}_${res.variantId}` },
        update: {},
        create: {
          idempotencyKey: `ord_commit_${orderId}_${res.variantId}`,
          inventoryItemId: row.id,
          variantId: res.variantId,
          type: InventoryMovementType.ORDER_COMMITTED,
          quantityDelta: res.quantity,
          onHandAfter: updatedItem.onHand,
          reservedAfter: updatedItem.reserved,
          committedAfter: updatedItem.committed,
          referenceType: 'ORDER',
          referenceId: orderId,
          actorId,
          reason: `Order ${orderId} finalized; inventory committed`,
        },
      });

      results.push(this.mapReservationToDto(updatedRes));
    }

    return results;
  }

  /**
   * Restores committed stock when an order is cancelled prior to shipment.
   * Decrements committed count back into uncommitted on-hand availability.
   */
  async restoreCancelledOrder(
    orderId: string,
    actorId: string,
    reason?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await this.executeTx(tx, async (transaction) => {
      const order = await transaction.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });

      if (!order) {
        return;
      }

      const validItems = order.items.filter(
        (i): i is typeof i & { variantId: string } =>
          typeof i.variantId === 'string' && i.variantId.length > 0,
      );

      if (validItems.length === 0) {
        return;
      }

      const sortedItems = [...validItems].sort((a, b) =>
        a.variantId.localeCompare(b.variantId),
      );
      const variantIds = sortedItems.map((i) => i.variantId);

      const lockedRows: Array<{
        id: string;
        variantId: string;
        onHand: number;
        reserved: number;
        committed: number;
        version: number;
      }> = await transaction.$queryRaw`
        SELECT id, "variantId", "onHand", reserved, committed, version
        FROM inventory_items
        WHERE "variantId" IN (${Prisma.join(variantIds)})
        ORDER BY "variantId" ASC
        FOR UPDATE
      `;

      const rowMap = new Map(lockedRows.map((r) => [r.variantId, r]));

      for (const item of sortedItems) {
        const row = rowMap.get(item.variantId);
        if (!row) continue;

        const idempotencyKey = `ord_cancel_${orderId}_${item.variantId}`;
        const existingMovement =
          await transaction.inventoryMovement.findUnique({
            where: { idempotencyKey },
          });

        if (existingMovement) {
          continue; // Already processed idempotently
        }

        const newCommitted = Math.max(0, row.committed - item.quantity);
        const updatedItem = await transaction.inventoryItem.update({
          where: { id: row.id },
          data: {
            committed: newCommitted,
            version: { increment: 1 },
          },
        });

        await transaction.inventoryMovement.create({
          data: {
            idempotencyKey,
            inventoryItemId: row.id,
            variantId: item.variantId,
            type: InventoryMovementType.ORDER_CANCELLED,
            quantityDelta: -item.quantity,
            onHandAfter: updatedItem.onHand,
            reservedAfter: updatedItem.reserved,
            committedAfter: updatedItem.committed,
            referenceType: 'ORDER',
            referenceId: orderId,
            actorId,
            reason: reason || `Order ${orderId} cancelled; committed stock restored`,
          },
        });
      }
    });
  }

  /**
   * Decrements physical onHand stock when an order is SHIPPED.
   * Goods physically depart warehouse facility: committed - qty, onHand - qty.
   */
  async shipOrderInventory(
    orderId: string,
    actorId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await this.executeTx(tx, async (transaction) => {
      const order = await transaction.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });

      if (!order) {
        return;
      }

      const validItems = order.items.filter(
        (i): i is typeof i & { variantId: string } =>
          typeof i.variantId === 'string' && i.variantId.length > 0,
      );

      if (validItems.length === 0) {
        return;
      }

      const sortedItems = [...validItems].sort((a, b) =>
        a.variantId.localeCompare(b.variantId),
      );
      const variantIds = sortedItems.map((i) => i.variantId);

      const lockedRows: Array<{
        id: string;
        variantId: string;
        onHand: number;
        reserved: number;
        committed: number;
        version: number;
      }> = await transaction.$queryRaw`
        SELECT id, "variantId", "onHand", reserved, committed, version
        FROM inventory_items
        WHERE "variantId" IN (${Prisma.join(variantIds)})
        ORDER BY "variantId" ASC
        FOR UPDATE
      `;

      const rowMap = new Map(lockedRows.map((r) => [r.variantId, r]));

      for (const item of sortedItems) {
        const row = rowMap.get(item.variantId);
        if (!row) continue;

        const idempotencyKey = `ord_ship_${orderId}_${item.variantId}`;
        const existingMovement =
          await transaction.inventoryMovement.findUnique({
            where: { idempotencyKey },
          });

        if (existingMovement) {
          continue; // Idempotently skipped
        }

        const newCommitted = Math.max(0, row.committed - item.quantity);
        const newOnHand = Math.max(0, row.onHand - item.quantity);

        const updatedItem = await transaction.inventoryItem.update({
          where: { id: row.id },
          data: {
            committed: newCommitted,
            onHand: newOnHand,
            version: { increment: 1 },
          },
        });

        await transaction.inventoryMovement.create({
          data: {
            idempotencyKey,
            inventoryItemId: row.id,
            variantId: item.variantId,
            type: InventoryMovementType.ORDER_SHIPPED,
            quantityDelta: -item.quantity,
            onHandAfter: updatedItem.onHand,
            reservedAfter: updatedItem.reserved,
            committedAfter: updatedItem.committed,
            referenceType: 'ORDER',
            referenceId: orderId,
            actorId,
            reason: `Order ${orderId} shipped; physical on-hand stock decremented`,
          },
        });
      }
    });
  }

  /**
   * Decrements physical onHand stock when a Shipment is SHIPPED (Phase 13).
   * Goods physically depart warehouse facility: committed - qty, onHand - qty.
   * Movement type: InventoryMovementType.ORDER_SHIPPED
   * Idempotency key: shp_ship_${shipmentId}_${variantId}
   */
  async shipShipmentInventory(
    params: {
      shipmentId: string;
      orderId: string;
      items: Array<{ variantId: string; quantity: number }>;
      actorId: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const { shipmentId, orderId, items, actorId } = params;

    await this.executeTx(tx, async (transaction) => {
      // 1. Filter valid items and aggregate quantities per variantId
      const variantQtyMap = new Map<string, number>();
      for (const item of items) {
        if (!item.variantId || item.quantity <= 0) continue;
        const current = variantQtyMap.get(item.variantId) || 0;
        variantQtyMap.set(item.variantId, current + item.quantity);
      }

      if (variantQtyMap.size === 0) {
        return;
      }

      // 2. Deadlock-free lexicographical sort of variant IDs
      const sortedVariantIds = Array.from(variantQtyMap.keys()).sort();

      // 3. Acquire pessimistic row locks on inventory items
      const lockedRows: Array<{
        id: string;
        variantId: string;
        onHand: number;
        reserved: number;
        committed: number;
        version: number;
      }> = await transaction.$queryRaw`
        SELECT id, "variantId", "onHand", reserved, committed, version
        FROM inventory_items
        WHERE "variantId" IN (${Prisma.join(sortedVariantIds)})
        ORDER BY "variantId" ASC
        FOR UPDATE
      `;

      const rowMap = new Map(lockedRows.map((r) => [r.variantId, r]));

      // 4. Atomically apply physical departure for each variant
      for (const variantId of sortedVariantIds) {
        const row = rowMap.get(variantId);
        if (!row) continue;

        const quantity = variantQtyMap.get(variantId) || 0;
        if (quantity <= 0) continue;

        const idempotencyKey = `shp_ship_${shipmentId}_${variantId}`;
        const existingMovement = await transaction.inventoryMovement.findUnique({
          where: { idempotencyKey },
        });

        if (existingMovement) {
          continue; // Idempotently skipped — movement already recorded
        }

        const newCommitted = Math.max(0, row.committed - quantity);
        const newOnHand = Math.max(0, row.onHand - quantity);

        const updatedItem = await transaction.inventoryItem.update({
          where: { id: row.id },
          data: {
            committed: newCommitted,
            onHand: newOnHand,
            version: { increment: 1 },
          },
        });

        await transaction.inventoryMovement.create({
          data: {
            idempotencyKey,
            inventoryItemId: row.id,
            variantId,
            type: InventoryMovementType.ORDER_SHIPPED,
            quantityDelta: -quantity,
            onHandAfter: updatedItem.onHand,
            reservedAfter: updatedItem.reserved,
            committedAfter: updatedItem.committed,
            referenceType: 'SHIPMENT',
            referenceId: shipmentId,
            actorId,
            reason: `Shipment ${shipmentId} (Order ${orderId}) dispatched; physical on-hand stock decremented`,
          },
        });
      }
    });
  }

  /**
   * Restocks verified returned items back into onHand inventory.
   * Triggered when an accepted return item has disposition RESTOCK.
   */
  async restockReturnItem(
    params: RestockReturnItemParams,
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryItemDto> {
    if (params.quantity <= 0) {
      throw new BadRequestException(
        `Restock quantity must be positive. Received: ${params.quantity}`,
      );
    }

    return this.executeTx(tx, async (transaction) => {
      // 1. Ensure InventoryItem exists
      await transaction.inventoryItem.upsert({
        where: { variantId: params.variantId },
        update: {},
        create: {
          variantId: params.variantId,
          onHand: 0,
          reserved: 0,
          committed: 0,
          lowStockThreshold: 5,
          version: 1,
        },
      });

      // 2. Lock item row
      const lockedRows: Array<{
        id: string;
        variantId: string;
        onHand: number;
        reserved: number;
        committed: number;
        version: number;
      }> = await transaction.$queryRaw`
        SELECT id, "variantId", "onHand", reserved, committed, version
        FROM inventory_items
        WHERE "variantId" = ${params.variantId}
        FOR UPDATE
      `;

      const row = lockedRows[0];
      if (!row) {
        throw new NotFoundException(
          `Inventory item for variant ${params.variantId} not found`,
        );
      }

      const idempotencyKey = `ret_restock_${params.returnItemId}`;
      const existingMovement = await transaction.inventoryMovement.findUnique({
        where: { idempotencyKey },
      });

      if (existingMovement) {
        const currentItem = await transaction.inventoryItem.findUniqueOrThrow({
          where: { id: row.id },
        });
        return this.mapItemToDto(currentItem);
      }

      const updatedItem = await transaction.inventoryItem.update({
        where: { id: row.id },
        data: {
          onHand: row.onHand + params.quantity,
          version: { increment: 1 },
        },
      });

      await transaction.returnItem.update({
        where: { id: params.returnItemId },
        data: {
          isRestocked: true,
          restockedAt: new Date(),
        },
      });

      await transaction.inventoryMovement.create({
        data: {
          idempotencyKey,
          inventoryItemId: row.id,
          variantId: params.variantId,
          type: InventoryMovementType.RETURN_RESTOCKED,
          quantityDelta: params.quantity,
          onHandAfter: updatedItem.onHand,
          reservedAfter: updatedItem.reserved,
          committedAfter: updatedItem.committed,
          referenceType: 'RETURN',
          referenceId: params.returnItemId,
          actorId: params.actorId,
          reason: params.reason || `Return item ${params.returnItemId} restocked`,
        },
      });

      return this.mapItemToDto(updatedItem);
    });
  }

  /**
   * Admin manual stock adjustment (intake or write-off).
   * Positive delta: intake (ADJUST_INCREASE).
   * Negative delta: write-off (ADJUST_DECREASE), guarded by available balance.
   */
  async adjustStock(
    params: AdjustStockParams,
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryItemDto> {
    if (params.delta === 0) {
      throw new BadRequestException('Stock adjustment delta cannot be 0.');
    }

    const idempotencyKey = `adj_${params.idempotencyKey}`;

    return this.executeTx(tx, async (transaction) => {
      // 1. Ensure inventory item exists
      await transaction.inventoryItem.upsert({
        where: { variantId: params.variantId },
        update: {},
        create: {
          variantId: params.variantId,
          onHand: 0,
          reserved: 0,
          committed: 0,
          lowStockThreshold: 5,
          version: 1,
        },
      });

      // 2. Check idempotency
      const existingMovement = await transaction.inventoryMovement.findUnique({
        where: { idempotencyKey },
      });

      if (existingMovement) {
        const item = await transaction.inventoryItem.findUniqueOrThrow({
          where: { variantId: params.variantId },
        });
        return this.mapItemToDto(item);
      }

      // 3. Lock item row
      const lockedRows: Array<{
        id: string;
        variantId: string;
        onHand: number;
        reserved: number;
        committed: number;
        version: number;
      }> = await transaction.$queryRaw`
        SELECT id, "variantId", "onHand", reserved, committed, version
        FROM inventory_items
        WHERE "variantId" = ${params.variantId}
        FOR UPDATE
      `;

      const row = lockedRows[0];
      if (!row) {
        throw new NotFoundException(
          `Inventory item for variant ${params.variantId} not found`,
        );
      }

      const newOnHand = row.onHand + params.delta;
      if (newOnHand < 0) {
        throw new BadRequestException(
          `Adjustment would result in negative on-hand stock (${newOnHand}).`,
        );
      }

      // Invariant check: onHand >= reserved + committed
      if (newOnHand < row.reserved + row.committed) {
        throw new BadRequestException(
          `Cannot reduce on-hand stock (${row.onHand}) by ${Math.abs(params.delta)}: would violate active commitments (reserved: ${row.reserved}, committed: ${row.committed}).`,
        );
      }

      const movementType =
        params.delta > 0
          ? InventoryMovementType.ADMIN_ADJUSTMENT_INCREASE
          : InventoryMovementType.ADMIN_ADJUSTMENT_DECREASE;

      const updatedItem = await transaction.inventoryItem.update({
        where: { id: row.id },
        data: {
          onHand: newOnHand,
          version: { increment: 1 },
        },
      });

      await transaction.inventoryMovement.create({
        data: {
          idempotencyKey,
          inventoryItemId: row.id,
          variantId: params.variantId,
          type: movementType,
          quantityDelta: params.delta,
          onHandAfter: updatedItem.onHand,
          reservedAfter: updatedItem.reserved,
          committedAfter: updatedItem.committed,
          referenceType: 'ADMIN',
          referenceId: params.idempotencyKey,
          actorId: params.actorId,
          reason: params.reason,
        },
      });

      // Audit log
      await this.auditService.logEvent({
        actorId: params.actorId,
        actorRole: params.actorRole,
        actorEmail: params.actorEmail,
        action: AuditAction.INVENTORY_ADJUSTED,
        entityType: AuditEntityType.INVENTORY_ITEM,
        entityId: updatedItem.id,
        previousValue: {
          onHand: row.onHand,
          reserved: row.reserved,
          committed: row.committed,
        },
        newValue: {
          onHand: updatedItem.onHand,
          reserved: updatedItem.reserved,
          committed: updatedItem.committed,
          delta: params.delta,
        },
        reason: params.reason,
      });

      return this.mapItemToDto(updatedItem);
    });
  }

  /**
   * Increases on-hand stock (e.g. delivery intake, stock found).
   * Direction: onHand += quantity, available += quantity.
   */
  async increaseStock(params: StockIncreaseParams): Promise<InventoryItemDto> {
    if (params.quantity <= 0) {
      throw new BadRequestException('Increase quantity must be positive.');
    }
    if (!params.reason || params.reason.trim().length < 5) {
      throw new BadRequestException('Reason must be at least 5 characters long.');
    }
    return this.adjustStock({
      variantId: params.variantId,
      delta: params.quantity,
      reason: params.notes ? `${params.reason} — ${params.notes}` : params.reason,
      idempotencyKey: params.idempotencyKey || `inc_${params.variantId}_${Date.now()}`,
      actorId: params.actorId,
      actorRole: params.actorRole,
      actorEmail: params.actorEmail,
    });
  }

  /**
   * Decreases on-hand stock (e.g. damage, shrinkage, internal use).
   * Can ONLY deduct from available (unreserved, uncommitted) stock!
   * Direction: onHand -= quantity, available -= quantity.
   */
  async decreaseStock(params: StockDecreaseParams): Promise<InventoryItemDto> {
    if (params.quantity <= 0) {
      throw new BadRequestException('Decrease quantity must be positive.');
    }
    if (!params.reason || params.reason.trim().length < 5) {
      throw new BadRequestException('Reason must be at least 5 characters long.');
    }
    return this.adjustStock({
      variantId: params.variantId,
      delta: -params.quantity,
      reason: params.notes ? `${params.reason} — ${params.notes}` : params.reason,
      idempotencyKey: params.idempotencyKey || `dec_${params.variantId}_${Date.now()}`,
      actorId: params.actorId,
      actorRole: params.actorRole,
      actorEmail: params.actorEmail,
    });
  }

  /**
   * Sweeper/Recovery: Expires reservations that have passed their TTL.
   * Releases stock back to unreserved pool.
   */
  async expireStaleReservations(
    limit: number = 50,
  ): Promise<{ expiredCount: number }> {
    const now = new Date();
    const staleReservations = await this.prisma.inventoryReservation.findMany({
      where: {
        status: ReservationStatus.PENDING,
        expiresAt: { lte: now },
      },
      take: limit,
      orderBy: { expiresAt: 'asc' },
    });

    if (staleReservations.length === 0) {
      return { expiredCount: 0 };
    }

    let expiredCount = 0;

    for (const res of staleReservations) {
      try {
        await this.prisma.$transaction(async (tx) => {
          // TWO-ENTITY LOCK HIERARCHY:
          // Step 1: Lock inventory_items FIRST
          const lockedItemRows: Array<{
            id: string;
            variantId: string;
            onHand: number;
            reserved: number;
            committed: number;
            version: number;
          }> = await tx.$queryRaw`
            SELECT id, "variantId", "onHand", reserved, committed, version
            FROM inventory_items
            WHERE "variantId" = ${res.variantId}
            FOR UPDATE
          `;

          const row = lockedItemRows[0];
          if (!row) return;

          // Step 2: Lock inventory_reservations SECOND
          const lockedResRows: Array<{
            id: string;
            variantId: string;
            inventoryItemId: string;
            checkoutSessionId: string;
            quantity: number;
            status: ReservationStatus;
            expiresAt: Date;
          }> = await tx.$queryRaw`
            SELECT id, "variantId", "inventoryItemId", "checkoutSessionId", quantity, status, "expiresAt"
            FROM inventory_reservations
            WHERE id = ${res.id}
            FOR UPDATE
          `;

          const currentRes = lockedResRows[0];
          if (!currentRes || currentRes.status !== ReservationStatus.PENDING) {
            return;
          }

          if (currentRes.expiresAt > now) {
            return;
          }

          const newReserved = Math.max(0, row.reserved - currentRes.quantity);
          const updatedItem = await tx.inventoryItem.update({
            where: { id: row.id },
            data: {
              reserved: newReserved,
              version: { increment: 1 },
            },
          });

          await tx.inventoryReservation.update({
            where: { id: currentRes.id },
            data: { status: ReservationStatus.EXPIRED },
          });

          await tx.inventoryMovement.upsert({
            where: { idempotencyKey: `res_expire_${currentRes.id}` },
            update: {},
            create: {
              idempotencyKey: `res_expire_${currentRes.id}`,
              inventoryItemId: row.id,
              variantId: currentRes.variantId,
              type: InventoryMovementType.RESERVATION_EXPIRED,
              quantityDelta: -currentRes.quantity,
              onHandAfter: updatedItem.onHand,
              reservedAfter: updatedItem.reserved,
              committedAfter: updatedItem.committed,
              referenceType: 'CHECKOUT_SESSION',
              referenceId: currentRes.checkoutSessionId,
              actorId: 'SYSTEM',
              reason: 'TTL expired; reserved stock automatically returned to unreserved pool',
            },
          });

          expiredCount++;
        });
      } catch (err: unknown) {
        this.logger.error(
          `Failed to expire reservation ${res.id}: ${(err as Error).message}`,
        );
      }
    }

    return { expiredCount };
  }

  /**
   * Paginated inventory list for admin portal.
   */
  async adminListInventory(query: AdminListInventoryQueryDto): Promise<{
    items: InventoryItemDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(query.page || 1, 1);
    const limit = Math.min(Math.max(query.limit || 20, 1), 100);
    const skip = (page - 1) * limit;

    const where: Prisma.InventoryItemWhereInput = {};

    if (query.variantId) {
      where.variantId = query.variantId;
    }

    if (query.sku) {
      where.variant = { sku: { contains: query.sku, mode: 'insensitive' } };
    }

    if (query.search?.trim()) {
      const q = query.search.trim();
      where.OR = [
        { variant: { sku: { contains: q, mode: 'insensitive' } } },
        { variant: { name: { contains: q, mode: 'insensitive' } } },
        { variant: { product: { name: { contains: q, mode: 'insensitive' } } } },
      ];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.inventoryItem.findMany({
        where,
        include: {
          variant: {
            select: {
              id: true,
              sku: true,
              name: true,
              productId: true,
              product: { select: { name: true } },
            },
          },
        },
        orderBy: [{ variant: { sku: 'asc' } }, { id: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.inventoryItem.count({ where }),
    ]);

    let dtoList = items.map((i) => this.mapItemToDto(i));

    if (query.lowStockOnly) {
      dtoList = dtoList.filter((i) => i.available <= i.lowStockThreshold);
    }

    return {
      items: dtoList,
      total,
      page,
      limit,
    };
  }

  /**
   * Paginated ledger movement history for an item or system-wide.
   */
  async adminListMovements(query: AdminListMovementsQueryDto): Promise<{
    movements: InventoryMovementDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(query.page || 1, 1);
    const limit = Math.min(Math.max(query.limit || 20, 1), 100);
    const skip = (page - 1) * limit;

    const where: Prisma.InventoryMovementWhereInput = {};

    if (query.variantId) {
      where.variantId = query.variantId;
    }
    if (query.type) {
      where.type = query.type;
    }
    if (query.referenceType) {
      where.referenceType = query.referenceType;
    }
    if (query.referenceId) {
      where.referenceId = query.referenceId;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.inventoryMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);

    return {
      movements: rows.map((m) => this.mapMovementToDto(m)),
      total,
      page,
      limit,
    };
  }

  // ---------------------------------------------------------------------------
  // Mappers
  // ---------------------------------------------------------------------------

  private mapItemToDto(
    item: Prisma.InventoryItemGetPayload<{
      include?: {
        variant?: {
          select: {
            id: true;
            sku: true;
            name: true;
            productId: true;
            product: { select: { name: true } };
          };
        };
      };
    }>,
  ): InventoryItemDto {
    const available = item.onHand - item.reserved - item.committed;
    return {
      id: item.id,
      variantId: item.variantId,
      onHand: item.onHand,
      reserved: item.reserved,
      committed: item.committed,
      available,
      lowStockThreshold: item.lowStockThreshold,
      isLowStock: available <= item.lowStockThreshold,
      version: item.version,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  private mapReservationToDto(
    res: {
      id: string;
      inventoryItemId: string;
      variantId: string;
      checkoutSessionId: string;
      orderId: string | null;
      quantity: number;
      status: ReservationStatus;
      expiresAt: Date;
      createdAt: Date;
      updatedAt: Date;
    },
  ): InventoryReservationDto {
    return {
      id: res.id,
      inventoryItemId: res.inventoryItemId,
      variantId: res.variantId,
      checkoutSessionId: res.checkoutSessionId,
      orderId: res.orderId,
      quantity: res.quantity,
      status: res.status as unknown as SharedReservationStatus,
      expiresAt: res.expiresAt.toISOString(),
      createdAt: res.createdAt.toISOString(),
      updatedAt: res.updatedAt.toISOString(),
    };
  }

  private mapMovementToDto(
    m: Prisma.InventoryMovementGetPayload<Record<string, never>>,
  ): InventoryMovementDto {
    return {
      id: m.id,
      idempotencyKey: m.idempotencyKey,
      inventoryItemId: m.inventoryItemId,
      variantId: m.variantId,
      type: m.type as unknown as SharedMovementType,
      quantityDelta: m.quantityDelta,
      onHandAfter: m.onHandAfter,
      reservedAfter: m.reservedAfter,
      committedAfter: m.committedAfter,
      availableAfter: m.onHandAfter - m.reservedAfter - m.committedAfter,
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      actorId: m.actorId,
      reason: m.reason,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
