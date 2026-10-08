/**
 * Checkout Types
 *
 * Domain types for Authoritative Checkout Preparation, Snapshotting, and Validation.
 *
 * Design Principles:
 * - Direct individual user model (requires authenticated USER)
 * - Server is authoritative: frontend prices, quantities, and subtotals are never trusted
 * - Immutable checkout item snapshots taken from live catalog and active cart state
 * - Strict non-destructive price-change and availability warnings
 * - Integer minor-unit money arithmetic (paise)
 * - Clear separation: Cart -> Checkout -> Payment -> Order
 * - Phase 08A: CheckoutSession owns the shipping address snapshot (copied to Order at finalization)
 */

// =============================================================================
// CONSTANTS
// =============================================================================

export const DEFAULT_CHECKOUT_SESSION_EXPIRY_MINUTES = 30;

// =============================================================================
// ENUMS
// =============================================================================

export enum CheckoutStatus {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum CheckoutIssueCode {
  PRICE_CHANGED = 'PRICE_CHANGED',
  PRODUCT_UNAVAILABLE = 'PRODUCT_UNAVAILABLE',
  VARIANT_UNAVAILABLE = 'VARIANT_UNAVAILABLE',
  VARIANT_MISMATCH = 'VARIANT_MISMATCH',
  INVALID_QUANTITY = 'INVALID_QUANTITY',
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',
  CART_EMPTY = 'CART_EMPTY',
  CART_CHANGED = 'CART_CHANGED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  INSUFFICIENT_STOCK = 'INSUFFICIENT_STOCK',
}

// =============================================================================
// VALIDATION ISSUES
// =============================================================================

export interface CheckoutValidationIssue {
  code: CheckoutIssueCode;
  message: string;
  productId?: string;
  productVariantId?: string;
  cartItemId?: string;
  productName?: string;
  sku?: string;
  previousPrice?: number; // In paise
  currentPrice?: number;  // In paise
  requestedQuantity?: number;
  availableQuantity?: number;
  maxQuantity?: number;
}

// =============================================================================
// SNAPSHOT & SESSION DTOS
// =============================================================================

export interface CheckoutItemSnapshotDto {
  id: string;
  checkoutSessionId: string;
  productId: string;
  productVariantId: string;
  productName: string;
  variantName: string;           // Phase 08A: authoritative variant name (e.g. "500ml")
  productSku: string;
  quantity: number;
  unitPrice: number; // paise
  lineTotal: number; // paise
  currency: string;
  primaryImageUrl?: string | null;
  createdAt: string;
}

export interface CheckoutSessionDto {
  id: string;
  userId: string;
  cartId: string | null;
  status: CheckoutStatus;
  currency: string;
  subtotal: number; // paise
  totalItems: number;
  items: CheckoutItemSnapshotDto[];
  isValid: boolean;
  issues: CheckoutValidationIssue[];
  shippingAddress?: {
    name?: string | null;
    phone?: string | null;
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
  } | null;
  idempotencyKey?: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RevalidateCheckoutResultDto {
  session: CheckoutSessionDto;
  isValid: boolean;
  issues: CheckoutValidationIssue[];
}

export interface BuyNowItemInput {
  productId: string;
  productVariantId: string;
  quantity: number;
}

export interface InitializeCheckoutInput {
  idempotencyKey?: string;
  shippingAddress?: {
    name: string;
    phone: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  buyNowItem?: BuyNowItemInput;
}
