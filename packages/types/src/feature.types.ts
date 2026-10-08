/**
 * Feature Registry Types
 *
 * The Feature Registry is a centralized system that controls what capabilities
 * exist in the platform, their states, metadata, and dependencies.
 *
 * Principle: The Feature Registry defines what capabilities exist;
 * the Permission Engine determines who can use those capabilities.
 */

export enum FeatureStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  HIDDEN = 'HIDDEN',
  BETA = 'BETA',
  COMING_SOON = 'COMING_SOON',
  MAINTENANCE = 'MAINTENANCE',
}

export enum FeatureKey {
  DASHBOARD = 'DASHBOARD',
  PRODUCTS = 'PRODUCTS',
  CATEGORIES = 'CATEGORIES',
  PRODUCT_VARIANTS = 'PRODUCT_VARIANTS',
  PRODUCT_MEDIA = 'PRODUCT_MEDIA',
  CART = 'CART',
  CHECKOUT = 'CHECKOUT',
  ORDERS = 'ORDERS',
  RETURNS = 'RETURNS',
  REFUNDS = 'REFUNDS',
  INVENTORY = 'INVENTORY',
  PAYMENTS = 'PAYMENTS',
  INVOICES = 'INVOICES',
  SHIPPING = 'SHIPPING',
  EXPENSES = 'EXPENSES',
  FINANCE = 'FINANCE',
  REPORTS = 'REPORTS',
  NOTIFICATIONS = 'NOTIFICATIONS',
  AUDIT_LOGS = 'AUDIT_LOGS',
  SETTINGS = 'SETTINGS',
  USER_MANAGEMENT = 'USER_MANAGEMENT',
  ADMIN_MANAGEMENT = 'ADMIN_MANAGEMENT',
  FEATURE_MANAGEMENT = 'FEATURE_MANAGEMENT',
  PERMISSION_MANAGEMENT = 'PERMISSION_MANAGEMENT',
}

export enum FeatureCategory {
  COMMERCE = 'COMMERCE',
  OPERATIONS = 'OPERATIONS',
  FINANCE = 'FINANCE',
  ADMINISTRATION = 'ADMINISTRATION',
  SYSTEM = 'SYSTEM',
}

export interface NavigationMetadata {
  path?: string;
  showInNav: boolean;
  navOrder: number;
  icon?: string;
  badge?: string;
}

/**
 * Authoritative feature definition in the registry.
 */
export interface FeatureDefinition {
  id: string;
  key: FeatureKey;
  name: string;
  description: string;
  status: FeatureStatus;
  category: FeatureCategory;
  defaultEnabled: boolean;
  permissions: string[];
  dependencies: FeatureKey[];
  navigation: NavigationMetadata;
  metadata?: Record<string, unknown>;
}

/**
 * Effective user feature access state.
 */
export interface UserFeatureAccess {
  key: FeatureKey;
  name: string;
  status: FeatureStatus;
  isEnabled: boolean;
  isAccessible: boolean; // Enabled AND user has required permissions
  category: FeatureCategory;
  navigation: NavigationMetadata;
  unmetDependencies: FeatureKey[];
}

export interface UpdateFeatureStatusDto {
  status: FeatureStatus;
  reason?: string;
}
