/**
 * Inventory & Stock Integrity Domain Types — Phase 11
 */

export enum ReservationStatus {
  PENDING = 'PENDING',
  COMMITTED = 'COMMITTED',
  RELEASED = 'RELEASED',
  EXPIRED = 'EXPIRED',
}

export enum InventoryMovementType {
  INITIAL_STOCK = 'INITIAL_STOCK',
  CHECKOUT_RESERVED = 'CHECKOUT_RESERVED',
  RESERVATION_RELEASED = 'RESERVATION_RELEASED',
  RESERVATION_EXPIRED = 'RESERVATION_EXPIRED',
  ORDER_COMMITTED = 'ORDER_COMMITTED',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  ORDER_SHIPPED = 'ORDER_SHIPPED',
  RETURN_RESTOCKED = 'RETURN_RESTOCKED',
  ADMIN_ADJUSTMENT_INCREASE = 'ADMIN_ADJUSTMENT_INCREASE',
  ADMIN_ADJUSTMENT_DECREASE = 'ADMIN_ADJUSTMENT_DECREASE',
}

export interface InventoryItemDto {
  id: string;
  variantId: string;
  onHand: number;
  reserved: number;
  committed: number;
  available: number; // Strictly derived: onHand - reserved - committed
  lowStockThreshold: number;
  isLowStock: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryReservationDto {
  id: string;
  inventoryItemId: string;
  variantId: string;
  checkoutSessionId: string;
  orderId: string | null;
  quantity: number;
  status: ReservationStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryMovementDto {
  id: string;
  idempotencyKey: string;
  inventoryItemId: string;
  variantId: string;
  type: InventoryMovementType;
  quantityDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  committedAfter: number;
  availableAfter: number; // Strictly derived: onHandAfter - reservedAfter - committedAfter
  referenceType: string;
  referenceId: string;
  actorId: string;
  reason: string;
  createdAt: string;
}

export interface AdjustStockDto {
  delta: number;
  reason: string;
  idempotencyKey: string;
}

export interface StockIncreaseDto {
  quantity: number;
  reason: string;
  notes?: string;
  idempotencyKey?: string;
}

export interface StockDecreaseDto {
  quantity: number;
  reason: string;
  notes?: string;
  idempotencyKey?: string;
}
