/**
 * Wishlist Types — Phase 20D.5
 */

export interface WishlistProductVariantSummary {
  id: string;
  name: string;
  sku: string;
  price: number;
  compareAtPrice?: number | null | undefined;
  currency: string;
  status: string;
  availableStock?: number | undefined;
  isOutOfStock?: boolean | undefined;
}

export interface WishlistProductSummary {
  id: string;
  name: string;
  slug: string;
  shortDescription?: string | null | undefined;
  brand?: string | null | undefined;
  primaryImage?: { url: string; altText?: string } | undefined;
  fromPrice?: number | undefined;
  fromCompareAtPrice?: number | undefined;
  currency: string;
  isOutOfStock?: boolean | undefined;
  variants: WishlistProductVariantSummary[];
}

export interface WishlistItemDto {
  id: string;
  userId: string;
  productId: string;
  variantId?: string | null | undefined;
  product: WishlistProductSummary;
  createdAt: string;
}

export interface AddWishlistItemInput {
  productId: string;
  variantId?: string | null | undefined;
}
