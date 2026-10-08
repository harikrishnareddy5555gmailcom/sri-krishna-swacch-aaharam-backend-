/**
 * Catalog Types
 *
 * Domain types for Product Catalog, Categories, Variants, and Media.
 *
 * Design Principles:
 * - Category → Product → Variant hierarchy with unlimited depth for categories
 * - No inventory quantities here (separate module in future)
 * - No payment/order state here (catalog identity only)
 * - Monetary values in smallest currency unit (paise) as integers
 * - Provider-independent media abstraction
 * - Public catalog APIs never expose cost/supplier/audit data
 */

// =============================================================================
// ENUMS
// =============================================================================

export enum ProductStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ARCHIVED = 'ARCHIVED',
}

export enum CategoryStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ARCHIVED = 'ARCHIVED',
}

export enum MediaType {
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
  DOCUMENT = 'DOCUMENT',
}

export enum ProductVariantStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  DISCONTINUED = 'DISCONTINUED',
}

// =============================================================================
// CATEGORY
// =============================================================================

export interface Category {
  id: string;
  name: string;
  slug: string;
  description?: string;
  imageUrl?: string;
  parentId?: string;
  status: CategoryStatus;
  sortOrder: number;
  productCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Category with nested children (tree representation).
 */
export interface CategoryTree extends Category {
  children?: CategoryTree[];
}

// =============================================================================
// PRODUCT
// =============================================================================

export interface Product {
  id: string;
  name: string;
  slug: string;
  shortDescription?: string;
  description?: string;
  categoryId: string;
  status: ProductStatus;
  brand?: string;
  images?: string[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// PRODUCT VARIANT
// =============================================================================

/**
 * A single purchasable variant of a product.
 *
 * Monetary values (price, compareAtPrice) are in the smallest currency unit
 * (paise for INR). Never use floating-point for monetary storage or display.
 */
export interface ProductVariant {
  id: string;
  productId: string;
  name: string;    // e.g. "500ml", "1L", "2L"
  packageSize?: string; // e.g. "1 L", "500 ml", "15 kg Tin"
  sku: string;     // Platform-unique
  /** Price in smallest currency unit (paise) */
  price: number;
  /** Optional compare-at / was price, in smallest currency unit */
  compareAtPrice?: number;
  currency: string; // ISO 4217, e.g. "INR"
  status: ProductVariantStatus;
  sortOrder: number;
  isDefault?: boolean;
  imageUrl?: string;
  mediaUrls?: string[];
  /** Free-form variant attributes (size, weight, color, etc.) */
  attributes?: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// PRODUCT MEDIA
// =============================================================================

/**
 * Provider-independent media record.
 *
 * Storage providers (S3, R2, local) are resolved server-side.
 * The frontend only receives a fully-resolved public URL.
 */
export interface ProductMedia {
  id: string;
  productId: string;
  variantId?: string; // Optionally linked to a specific variant
  mediaType: MediaType;
  /** Fully-resolved public URL (provider-agnostic) */
  url: string;
  altText?: string;
  sortOrder: number;
  isPrimary: boolean;
  createdAt: Date;
}

// =============================================================================
// PUBLIC CATALOG DTOs (safe for public API responses)
// =============================================================================

/**
 * Public-safe category response.
 * Never includes internal metadata or admin-only fields.
 */
export interface PublicCategoryDto {
  id: string;
  name: string;
  slug: string;
  description?: string;
  imageUrl?: string;
  parentId?: string;
  sortOrder: number;
  productCount?: number;
  children?: PublicCategoryDto[];
}

/**
 * Public-safe product listing item (used in listings).
 */
export interface PublicProductListItem {
  id: string;
  name: string;
  slug: string;
  shortDescription?: string;
  brand?: string;
  categoryId: string;
  primaryImage?: { url: string; altText?: string };
  /** Lowest active variant price in paise */
  fromPrice?: number;
  /** Compare-at / MRP for the lowest active variant in paise */
  fromCompareAtPrice?: number;
  currency: string;
  defaultVariantId?: string;
  status?: string | ProductStatus;
  metadata?: Record<string, unknown>;
  isLowStock?: boolean;
  isOutOfStock?: boolean;
}

/**
 * Public-safe full product detail.
 */
export interface PublicProductDetailDto extends PublicProductListItem {
  description?: string;
  images?: string[];
  variants: PublicVariantDto[];
  media: PublicMediaDto[];
}

export interface PublicVariantDto {
  id: string;
  name: string;
  packageSize?: string;
  imageUrl?: string;
  mediaUrls?: string[];
  sku: string;
  price: number;
  compareAtPrice?: number;
  currency: string;
  status: ProductVariantStatus;
  sortOrder: number;
  isDefault?: boolean;
  attributes?: Record<string, string>;
  availableStock?: number;
  isOutOfStock?: boolean;
}

export interface PublicMediaDto {
  id: string;
  mediaType: MediaType;
  url: string;
  altText?: string;
  sortOrder: number;
  isPrimary: boolean;
}

// =============================================================================
// ADMIN DTOs
// =============================================================================

export interface UpsertProductVariantDto {
  id?: string | undefined;               // Present if existing variant, omitted if new
  title?: string | undefined;            // e.g., "1 L Cold Pressed Groundnut Oil"
  name?: string | undefined;             // Variant display name
  packageSize: string;                   // e.g., "1 L"
  sku?: string | undefined;              // Auto-generated if omitted
  price: number;                         // Selling Price in Paise
  compareAtPrice?: number | undefined;   // MRP in Paise
  stock?: number | undefined;            // Available inventory units
  imageUrl?: string | undefined;         // Dedicated image for this package size
  mediaUrls?: string[] | undefined;      // Optional secondary gallery images
  isDefault?: boolean | undefined;       // Marks primary variant
  isActive?: boolean | undefined;
}

export interface CreateCategoryDto {
  name: string;
  slug: string;
  description?: string;
  imageUrl?: string;
  parentId?: string;
  sortOrder?: number;
  status?: CategoryStatus;
}

export interface UpdateCategoryDto {
  name?: string;
  slug?: string;
  description?: string;
  imageUrl?: string;
  parentId?: string | null; // null to detach from parent (move to root)
  sortOrder?: number;
  status?: CategoryStatus;
}

export interface CreateProductDto {
  name: string;
  slug?: string;
  shortDescription?: string;
  description?: string;
  categoryId: string;
  brand?: string;
  status?: ProductStatus;
  images?: string[];
  variants?: UpsertProductVariantDto[];
  metadata?: Record<string, unknown>;
}

export interface UpdateProductDto {
  name?: string;
  slug?: string;
  shortDescription?: string;
  description?: string;
  categoryId?: string;
  brand?: string;
  status?: ProductStatus;
  images?: string[];
  variants?: UpsertProductVariantDto[];
  metadata?: Record<string, unknown>;
}

export interface CreateProductVariantDto {
  name: string;
  packageSize?: string;
  sku: string;
  /** Price in smallest currency unit (paise) */
  price: number;
  /** Compare-at price in smallest currency unit */
  compareAtPrice?: number;
  currency?: string;
  status?: ProductVariantStatus;
  sortOrder?: number;
  isDefault?: boolean;
  imageUrl?: string;
  mediaUrls?: string[];
  attributes?: Record<string, string>;
}

export interface UpdateProductVariantDto {
  name?: string;
  packageSize?: string;
  sku?: string;
  price?: number;
  compareAtPrice?: number;
  currency?: string;
  status?: ProductVariantStatus;
  sortOrder?: number;
  isDefault?: boolean;
  imageUrl?: string;
  mediaUrls?: string[];
  attributes?: Record<string, string>;
}

export interface CreateProductMediaDto {
  url: string;
  altText?: string;
  mediaType?: MediaType;
  sortOrder?: number;
  isPrimary?: boolean;
  variantId?: string;
}

// =============================================================================
// CATALOG PAGINATION (extends api.types.ts conventions)
// =============================================================================

export interface CatalogPaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export type CatalogSortOption = 'price_asc' | 'price_desc' | 'name_asc' | 'featured';

export interface PublicCatalogQuery {
  page?: number;
  limit?: number;
  categoryId?: string;
  categoryIds?: string | string[];
  search?: string;
  sortBy?: CatalogSortOption;
}
