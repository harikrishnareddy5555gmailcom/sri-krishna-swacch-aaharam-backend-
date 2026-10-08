import type { FeatureKey } from './feature.types.js';
import type { UserRole } from './role.types.js';

/**
 * Permission Model Types
 *
 * Implements granular RESOURCE.ACTION permissions.
 * Authorization evaluates permissions hierarchically:
 *
 *   SUPER_ADMIN (Platform wildcard)
 *     ↓
 *   Explicit User Denials (DENY overrides all)
 *     ↓
 *   Explicit User Grants (ALLOW)
 *     ↓
 *   Role Permissions (ALLOW / DENY)
 */

export enum PermissionEffect {
  ALLOW = 'ALLOW',
  DENY = 'DENY',
  INHERIT = 'INHERIT',
}

/**
 * Well-known core permissions supported across the platform.
 */
export const Permissions = {
  // Dashboard
  DASHBOARD_VIEW: 'DASHBOARD.VIEW',

  // Products
  PRODUCTS_VIEW: 'PRODUCTS.VIEW',
  PRODUCTS_CREATE: 'PRODUCTS.CREATE',
  PRODUCTS_UPDATE: 'PRODUCTS.UPDATE',
  PRODUCTS_DELETE: 'PRODUCTS.DELETE',
  PRODUCTS_PUBLISH: 'PRODUCTS.PUBLISH',

  // Product Variants
  PRODUCT_VARIANTS_VIEW: 'PRODUCT_VARIANTS.VIEW',
  PRODUCT_VARIANTS_CREATE: 'PRODUCT_VARIANTS.CREATE',
  PRODUCT_VARIANTS_UPDATE: 'PRODUCT_VARIANTS.UPDATE',
  PRODUCT_VARIANTS_DELETE: 'PRODUCT_VARIANTS.DELETE',

  // Product Media
  PRODUCT_MEDIA_VIEW: 'PRODUCT_MEDIA.VIEW',
  PRODUCT_MEDIA_MANAGE: 'PRODUCT_MEDIA.MANAGE',

  // Categories
  CATEGORIES_VIEW: 'CATEGORIES.VIEW',
  CATEGORIES_CREATE: 'CATEGORIES.CREATE',
  CATEGORIES_UPDATE: 'CATEGORIES.UPDATE',
  CATEGORIES_DELETE: 'CATEGORIES.DELETE',
  CATEGORIES_MANAGE: 'CATEGORIES.MANAGE', // Legacy: kept for backward compat

  // Cart & Checkout
  CART_VIEW: 'CART.VIEW',
  CART_CREATE: 'CART.CREATE',
  CART_UPDATE: 'CART.UPDATE',
  CART_DELETE: 'CART.DELETE',
  CART_MANAGE: 'CART.MANAGE',
  CHECKOUT_VIEW: 'CHECKOUT.VIEW',
  CHECKOUT_MANAGE: 'CHECKOUT.MANAGE',

  // Orders
  ORDERS_VIEW: 'ORDERS.VIEW',
  ORDERS_CREATE: 'ORDERS.CREATE',
  ORDERS_UPDATE: 'ORDERS.UPDATE',
  ORDERS_CANCEL: 'ORDERS.CANCEL',

  // Returns
  RETURNS_VIEW: 'RETURNS.VIEW',
  RETURNS_CREATE: 'RETURNS.CREATE',
  RETURNS_APPROVE: 'RETURNS.APPROVE',
  RETURNS_REJECT: 'RETURNS.REJECT',
  RETURNS_INSPECT: 'RETURNS.INSPECT', // Phase 10: Warehouse physical receipt and inspection
  RETURNS_MANAGE: 'RETURNS.MANAGE',   // Phase 10: Admin override, delivery window bypass, operational cancellation

  // Refunds
  REFUNDS_VIEW: 'REFUNDS.VIEW',
  REFUNDS_CREATE: 'REFUNDS.CREATE',
  REFUNDS_APPROVE: 'REFUNDS.APPROVE',
  REFUNDS_MANAGE: 'REFUNDS.MANAGE',       // Cancel pending refunds, trigger controlled retry
  REFUNDS_RECONCILE: 'REFUNDS.RECONCILE', // Manually resolve ambiguous/timed-out refunds

  // Inventory
  INVENTORY_VIEW: 'INVENTORY.VIEW',
  INVENTORY_MANAGE: 'INVENTORY.MANAGE',

  // Financial
  PAYMENTS_VIEW: 'PAYMENTS.VIEW',
  PAYMENTS_CREATE: 'PAYMENTS.CREATE',
  PAYMENTS_MANAGE: 'PAYMENTS.MANAGE',
  INVOICES_VIEW: 'INVOICES.VIEW',
  INVOICES_MANAGE: 'INVOICES.MANAGE',
  EXPENSES_VIEW: 'EXPENSES.VIEW',
  EXPENSES_CREATE: 'EXPENSES.CREATE',
  EXPENSES_UPDATE: 'EXPENSES.UPDATE',
  EXPENSES_SUBMIT: 'EXPENSES.SUBMIT',
  EXPENSES_APPROVE: 'EXPENSES.APPROVE',
  EXPENSES_REJECT: 'EXPENSES.REJECT',
  EXPENSES_POST: 'EXPENSES.POST',
  EXPENSES_CANCEL: 'EXPENSES.CANCEL',
  EXPENSES_MANAGE: 'EXPENSES.MANAGE',
  REPORTS_VIEW: 'REPORTS.VIEW',
  FINANCE_VIEW: 'FINANCE.VIEW',
  FINANCE_POST: 'FINANCE.POST',
  FINANCE_MANAGE: 'FINANCE.MANAGE',
  FINANCE_VOID: 'FINANCE.VOID',

  // Shipping & Fulfillment (Phase 13)
  SHIPPING_VIEW: 'SHIPPING.VIEW',
  SHIPPING_CREATE: 'SHIPPING.CREATE',
  SHIPPING_UPDATE: 'SHIPPING.UPDATE',
  SHIPPING_CANCEL: 'SHIPPING.CANCEL',
  SHIPPING_OVERRIDE: 'SHIPPING.OVERRIDE',
  SHIPPING_RECONCILE: 'SHIPPING.RECONCILE',

  // Notifications (Phase 14)
  NOTIFICATIONS_VIEW: 'NOTIFICATIONS.VIEW',
  NOTIFICATIONS_MANAGE: 'NOTIFICATIONS.MANAGE',
  NOTIFICATIONS_RETRY: 'NOTIFICATIONS.RETRY',
  NOTIFICATIONS_TEMPLATES: 'NOTIFICATIONS.TEMPLATES',

  // Users & Admins
  USERS_VIEW: 'USERS.VIEW',
  USERS_UPDATE: 'USERS.UPDATE',
  ADMINS_MANAGE: 'ADMINS.MANAGE',

  // System & Governance
  AUDIT_LOGS_VIEW: 'AUDIT_LOGS.VIEW',
  SETTINGS_VIEW: 'SETTINGS.VIEW',
  SETTINGS_MANAGE: 'SETTINGS.MANAGE',

  // Registry & Permissions (Super Admin Boundary)
  FEATURES_VIEW: 'FEATURES.VIEW',
  FEATURES_MANAGE: 'FEATURES.MANAGE',
  PERMISSIONS_VIEW: 'PERMISSIONS.VIEW',
  PERMISSIONS_MANAGE: 'PERMISSIONS.MANAGE',
  ROLES_VIEW: 'ROLES.VIEW',
  ROLES_MANAGE: 'ROLES.MANAGE',
} as const;

export type PermissionString = (typeof Permissions)[keyof typeof Permissions] | (string & {});

/**
 * Authoritative permission record.
 */
export interface PermissionDefinition {
  id: string;
  key: string;
  resource: string;
  action: string;
  description: string;
  featureKey: FeatureKey;
  isAssignableToAdmin: boolean; // Super Admin boundary: whether this can be delegated to Admins
}

export type Permission = PermissionDefinition;

/**
 * Role Permission Mapping.
 */
export interface RolePermissionMapping {
  id: string;
  roleName: UserRole;
  permissionKey: string;
  effect: PermissionEffect;
}

/**
 * Direct user permission grant/denial.
 */
export interface UserPermissionGrant {
  id: string;
  userId: string;
  permissionKey: string;
  effect: PermissionEffect;
  grantedById?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Evaluated effective permissions for a user.
 */
export interface UserEffectivePermissions {
  userId: string;
  role: UserRole;
  allowed: string[];
  denied: string[];
  isSuperAdmin: boolean;
}

/**
 * DTO for granting/revoking permissions.
 */
export interface GrantPermissionDto {
  targetUserId: string;
  permissionKey: string;
  effect: PermissionEffect;
  reason?: string;
}

export interface RevokePermissionDto {
  targetUserId: string;
  permissionKey: string;
  reason?: string;
}
