/**
 * Cart Types
 *
 * Domain types for Shopping Cart, Cart Items, and Guest-to-User Merging.
 *
 * Design Principles:
 * - Direct individual user model (guest + authenticated user)
 * - Cryptographically random guest cart tokens (stored hashed, never credentials)
 * - Monetary values in smallest currency unit (paise) as integers
 * - Prices are snapshotted on add/update from authoritative catalog data
 * - Future checkout will independently re-validate availability and price
 * - Quantity limits are enforced through a centralized rule (MAX_CART_ITEM_QUANTITY)
 * - Subtotals calculated server-side; frontend totals are never trusted
 */

import type { ProductStatus, ProductVariantStatus } from './catalog.types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

export const DEFAULT_MAX_CART_ITEM_QUANTITY = 20;
export const GUEST_CART_EXPIRY_DAYS = 30;

// =============================================================================
// ENUMS
// =============================================================================

export enum CartStatus {
  ACTIVE = 'ACTIVE',
  MERGED = 'MERGED',
  ABANDONED = 'ABANDONED',
  CONVERTED = 'CONVERTED', // Converted into an order in future checkout
}

// =============================================================================
// DATA TRANSFER OBJECTS (DTOs)
// =============================================================================

export interface CartProductSummary {
  id: string;
  name: string;
  slug: string;
  status: ProductStatus;
  primaryImage?: {
    url: string;
    altText?: string | null;
  } | null;
}

export interface CartVariantSummary {
  id: string;
  name: string;
  sku: string;
  price: number; // Current authoritative price in paise
  compareAtPrice?: number | null;
  status: ProductVariantStatus;
}

export interface CartItemDto {
  id: string;
  cartId: string;
  productId: string;
  productVariantId: string;
  quantity: number;
  unitPrice: number; // Snapshot price in paise at time of add/update
  lineTotal: number; // unitPrice * quantity in paise
  currency: string;
  isAvailable: boolean; // true if both product and variant are ACTIVE
  product: CartProductSummary;
  variant: CartVariantSummary;
  createdAt: string;
  updatedAt: string;
}

export interface CartSummaryDto {
  id: string;
  status: CartStatus;
  currency: string;
  items: CartItemDto[];
  totalItems: number; // Sum of quantities
  subtotal: number; // Server-authoritative subtotal in paise for available items
  guestToken?: string; // Provided to client for guest carts
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AddToCartDto {
  productId: string;
  productVariantId: string;
  quantity: number;
}

export interface UpdateCartItemDto {
  quantity: number;
}

export interface MergeCartDto {
  guestToken: string;
}

export interface MergeCartResultDto {
  cart: CartSummaryDto;
  mergedCount: number;
  warnings?: string[];
}
