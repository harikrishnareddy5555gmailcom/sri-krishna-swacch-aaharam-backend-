import {
  FeatureCategory,
  FeatureKey,
  FeatureStatus,
  type FeatureDefinition,
} from '@vishkaraa/types';
import { Permissions } from '@vishkaraa/types';

/**
 * Authoritative Central Feature Registry
 *
 * Single source of truth for all features, their metadata, dependencies,
 * and associated permissions.
 */
export const FEATURE_REGISTRY: Record<FeatureKey, FeatureDefinition> = {
  [FeatureKey.DASHBOARD]: {
    id: 'feat-dashboard',
    key: FeatureKey.DASHBOARD,
    name: 'Dashboard',
    description: 'Operational overview and metrics',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.COMMERCE,
    defaultEnabled: true,
    permissions: [Permissions.DASHBOARD_VIEW],
    dependencies: [],
    navigation: {
      path: '/dashboard',
      showInNav: true,
      navOrder: 1,
      icon: 'dashboard',
    },
  },
  [FeatureKey.PRODUCTS]: {
    id: 'feat-products',
    key: FeatureKey.PRODUCTS,
    name: 'Products',
    description: 'Product catalog and listings',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.COMMERCE,
    defaultEnabled: true,
    permissions: [
      Permissions.PRODUCTS_VIEW,
      Permissions.PRODUCTS_CREATE,
      Permissions.PRODUCTS_UPDATE,
      Permissions.PRODUCTS_DELETE,
      Permissions.PRODUCTS_PUBLISH,
    ],
    dependencies: [],
    navigation: {
      path: '/products',
      showInNav: true,
      navOrder: 2,
      icon: 'package',
    },
  },
  [FeatureKey.CATEGORIES]: {
    id: 'feat-categories',
    key: FeatureKey.CATEGORIES,
    name: 'Categories',
    description: 'Product taxonomic organization and hierarchy',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.COMMERCE,
    defaultEnabled: true,
    permissions: [
      Permissions.CATEGORIES_VIEW,
      Permissions.CATEGORIES_CREATE,
      Permissions.CATEGORIES_UPDATE,
      Permissions.CATEGORIES_DELETE,
      Permissions.CATEGORIES_MANAGE,
    ],
    dependencies: [FeatureKey.PRODUCTS],
    navigation: {
      path: '/categories',
      showInNav: true,
      navOrder: 3,
      icon: 'folder',
    },
  },
  [FeatureKey.PRODUCT_VARIANTS]: {
    id: 'feat-product-variants',
    key: FeatureKey.PRODUCT_VARIANTS,
    name: 'Product Variants',
    description: 'SKUs, pricing tiers, and variant management',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.COMMERCE,
    defaultEnabled: true,
    permissions: [
      Permissions.PRODUCT_VARIANTS_VIEW,
      Permissions.PRODUCT_VARIANTS_CREATE,
      Permissions.PRODUCT_VARIANTS_UPDATE,
      Permissions.PRODUCT_VARIANTS_DELETE,
    ],
    dependencies: [FeatureKey.PRODUCTS],
    navigation: {
      path: '/admin/variants',
      showInNav: false,
      navOrder: 4,
      icon: 'layers',
    },
  },
  [FeatureKey.PRODUCT_MEDIA]: {
    id: 'feat-product-media',
    key: FeatureKey.PRODUCT_MEDIA,
    name: 'Product Media',
    description: 'Product images and media management',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.COMMERCE,
    defaultEnabled: true,
    permissions: [
      Permissions.PRODUCT_MEDIA_VIEW,
      Permissions.PRODUCT_MEDIA_MANAGE,
    ],
    dependencies: [FeatureKey.PRODUCTS],
    navigation: {
      path: '/admin/media',
      showInNav: false,
      navOrder: 5,
      icon: 'image',
    },
  },
  [FeatureKey.CART]: {
    id: 'feat-cart',
    key: FeatureKey.CART,
    name: 'Shopping Cart',
    description: 'Item selection and pre-purchase holding',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.COMMERCE,
    defaultEnabled: true,
    permissions: [
      Permissions.CART_VIEW,
      Permissions.CART_CREATE,
      Permissions.CART_UPDATE,
      Permissions.CART_DELETE,
      Permissions.CART_MANAGE,
    ],
    dependencies: [FeatureKey.PRODUCTS],
    navigation: {
      path: '/cart',
      showInNav: true,
      navOrder: 4,
      icon: 'shopping-cart',
    },
  },
  [FeatureKey.CHECKOUT]: {
    id: 'feat-checkout',
    key: FeatureKey.CHECKOUT,
    name: 'Checkout',
    description: 'Order placement and payment authorization initiation',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.COMMERCE,
    defaultEnabled: true,
    permissions: [Permissions.CHECKOUT_VIEW, Permissions.CHECKOUT_MANAGE],
    dependencies: [FeatureKey.CART],
    navigation: {
      path: '/checkout',
      showInNav: false,
      navOrder: 5,
      icon: 'credit-card',
    },
  },
  [FeatureKey.ORDERS]: {
    id: 'feat-orders',
    key: FeatureKey.ORDERS,
    name: 'Orders',
    description: 'Order processing, fulfillment tracking, and lifecycle',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.COMMERCE,
    defaultEnabled: true,
    permissions: [
      Permissions.ORDERS_VIEW,
      Permissions.ORDERS_CREATE,
      Permissions.ORDERS_UPDATE,
      Permissions.ORDERS_CANCEL,
    ],
    dependencies: [FeatureKey.CHECKOUT],
    navigation: {
      path: '/orders',
      showInNav: true,
      navOrder: 6,
      icon: 'clipboard-list',
    },
  },
  [FeatureKey.RETURNS]: {
    id: 'feat-returns',
    key: FeatureKey.RETURNS,
    name: 'Returns',
    description: 'Return merchandise authorization, inspection, and review',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.OPERATIONS,
    defaultEnabled: true,
    permissions: [
      Permissions.RETURNS_VIEW,
      Permissions.RETURNS_CREATE,
      Permissions.RETURNS_APPROVE,
      Permissions.RETURNS_REJECT,
      Permissions.RETURNS_INSPECT, // Phase 10: warehouse inspection operations
      Permissions.RETURNS_MANAGE,  // Phase 10: admin override and delivery window bypass
    ],
    dependencies: [FeatureKey.ORDERS],
    navigation: {
      path: '/returns',
      showInNav: true,
      navOrder: 7,
      icon: 'rotate-ccw',
    },
  },
  [FeatureKey.REFUNDS]: {
    id: 'feat-refunds',
    key: FeatureKey.REFUNDS,
    name: 'Refunds & Financial Reconciliation',
    description: 'Payment disbursement, partial refunds, and gateway balance reconciliation',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.FINANCE,
    defaultEnabled: true,
    permissions: [
      Permissions.REFUNDS_VIEW,
      Permissions.REFUNDS_CREATE,
      Permissions.REFUNDS_APPROVE,
      Permissions.REFUNDS_MANAGE,
      Permissions.REFUNDS_RECONCILE,
    ],
    dependencies: [FeatureKey.ORDERS, FeatureKey.PAYMENTS],
    navigation: {
      path: '/admin/refunds',
      showInNav: true,
      navOrder: 8,
      icon: 'receipt',
    },
  },
  [FeatureKey.INVENTORY]: {
    id: 'feat-inventory',
    key: FeatureKey.INVENTORY,
    name: 'Inventory',
    description: 'Stock level tracking and warehouse replenishment alerts',
    status: FeatureStatus.BETA,
    category: FeatureCategory.OPERATIONS,
    defaultEnabled: false,
    permissions: [Permissions.INVENTORY_VIEW, Permissions.INVENTORY_MANAGE],
    dependencies: [FeatureKey.PRODUCTS],
    navigation: {
      path: '/inventory',
      showInNav: true,
      navOrder: 9,
      icon: 'archive',
      badge: 'BETA',
    },
  },
  [FeatureKey.PAYMENTS]: {
    id: 'feat-payments',
    key: FeatureKey.PAYMENTS,
    name: 'Payments',
    description: 'Payment gateway integration and transaction history',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.FINANCE,
    defaultEnabled: true,
    permissions: [
      Permissions.PAYMENTS_VIEW,
      Permissions.PAYMENTS_CREATE,
      Permissions.PAYMENTS_MANAGE,
    ],
    dependencies: [FeatureKey.CHECKOUT],
    navigation: {
      path: '/payments',
      showInNav: false,
      navOrder: 10,
      icon: 'wallet',
    },
  },
  [FeatureKey.INVOICES]: {
    id: 'feat-invoices',
    key: FeatureKey.INVOICES,
    name: 'Invoices',
    description: 'Tax-compliant GST invoice generation and PDF exports',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.FINANCE,
    defaultEnabled: true,
    permissions: [Permissions.INVOICES_VIEW, Permissions.INVOICES_MANAGE],
    dependencies: [FeatureKey.ORDERS],
    navigation: {
      path: '/invoices',
      showInNav: true,
      navOrder: 11,
      icon: 'file-text',
    },
  },
  [FeatureKey.SHIPPING]: {
    id: 'feat-shipping',
    key: FeatureKey.SHIPPING,
    name: 'Shipping & Fulfillment',
    description: 'Parcel packing, courier dispatch, tracking telemetry, and delivery operations',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.OPERATIONS,
    defaultEnabled: true,
    permissions: [
      Permissions.SHIPPING_VIEW,
      Permissions.SHIPPING_CREATE,
      Permissions.SHIPPING_UPDATE,
      Permissions.SHIPPING_CANCEL,
      Permissions.SHIPPING_OVERRIDE,
      Permissions.SHIPPING_RECONCILE,
    ],
    dependencies: [FeatureKey.ORDERS, FeatureKey.INVENTORY],
    navigation: {
      path: '/admin/shipping',
      showInNav: true,
      navOrder: 12,
      icon: 'truck',
    },
  },
  [FeatureKey.EXPENSES]: {
    id: 'feat-expenses',
    key: FeatureKey.EXPENSES,
    name: 'Expenses',
    description: 'Operational expenditure tracking and supplier cost logs',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.FINANCE,
    defaultEnabled: true,
    permissions: [
      Permissions.EXPENSES_VIEW,
      Permissions.EXPENSES_CREATE,
      Permissions.EXPENSES_UPDATE,
      Permissions.EXPENSES_SUBMIT,
      Permissions.EXPENSES_APPROVE,
      Permissions.EXPENSES_REJECT,
      Permissions.EXPENSES_POST,
      Permissions.EXPENSES_CANCEL,
      Permissions.EXPENSES_MANAGE,
    ],
    dependencies: [FeatureKey.PAYMENTS],
    navigation: {
      path: '/admin/expenses',
      showInNav: true,
      navOrder: 13,
      icon: 'receipt',
    },
  },
  [FeatureKey.FINANCE]: {
    id: 'feat-finance',
    key: FeatureKey.FINANCE,
    name: 'Finance & Reporting',
    description: 'Double-entry general ledger, accounting entries, and financial statements',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.FINANCE,
    defaultEnabled: true,
    permissions: [
      Permissions.FINANCE_VIEW,
      Permissions.FINANCE_POST,
      Permissions.FINANCE_MANAGE,
      Permissions.FINANCE_VOID,
    ],
    dependencies: [],
    navigation: {
      path: '/admin/finance',
      showInNav: true,
      navOrder: 14,
      icon: 'dollar-sign',
    },
  },
  [FeatureKey.REPORTS]: {
    id: 'feat-reports',
    key: FeatureKey.REPORTS,
    name: 'Reports',
    description: 'Business intelligence summaries and analytical exports',
    status: FeatureStatus.BETA,
    category: FeatureCategory.OPERATIONS,
    defaultEnabled: false,
    permissions: [Permissions.REPORTS_VIEW],
    dependencies: [FeatureKey.ORDERS],
    navigation: {
      path: '/reports',
      showInNav: true,
      navOrder: 13,
      icon: 'bar-chart',
      badge: 'BETA',
    },
  },
  [FeatureKey.NOTIFICATIONS]: {
    id: 'feat-notifications',
    key: FeatureKey.NOTIFICATIONS,
    name: 'Notifications',
    description: 'Real-time in-app alerts and transactional email triggers',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.SYSTEM,
    defaultEnabled: true,
    permissions: [
      Permissions.NOTIFICATIONS_VIEW,
      Permissions.NOTIFICATIONS_MANAGE,
      Permissions.NOTIFICATIONS_RETRY,
      Permissions.NOTIFICATIONS_TEMPLATES,
    ],
    dependencies: [],
    navigation: {
      path: '/notifications',
      showInNav: false,
      navOrder: 14,
      icon: 'bell',
    },
  },
  [FeatureKey.AUDIT_LOGS]: {
    id: 'feat-audit-logs',
    key: FeatureKey.AUDIT_LOGS,
    name: 'Audit Logs',
    description: 'Append-only regulatory and security activity ledger',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.SYSTEM,
    defaultEnabled: true,
    permissions: [Permissions.AUDIT_LOGS_VIEW],
    dependencies: [],
    navigation: {
      path: '/admin/audit',
      showInNav: true,
      navOrder: 15,
      icon: 'shield-check',
    },
  },
  [FeatureKey.SETTINGS]: {
    id: 'feat-settings',
    key: FeatureKey.SETTINGS,
    name: 'Settings',
    description: 'Platform configuration, store parameters, and preferences',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.SYSTEM,
    defaultEnabled: true,
    permissions: [Permissions.SETTINGS_VIEW, Permissions.SETTINGS_MANAGE],
    dependencies: [],
    navigation: {
      path: '/settings',
      showInNav: true,
      navOrder: 16,
      icon: 'settings',
    },
  },
  [FeatureKey.USER_MANAGEMENT]: {
    id: 'feat-user-mgmt',
    key: FeatureKey.USER_MANAGEMENT,
    name: 'User Management',
    description: 'Directory, verification status, and profile administration',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.ADMINISTRATION,
    defaultEnabled: true,
    permissions: [Permissions.USERS_VIEW, Permissions.USERS_UPDATE],
    dependencies: [],
    navigation: {
      path: '/admin/users',
      showInNav: true,
      navOrder: 17,
      icon: 'users',
    },
  },
  [FeatureKey.ADMIN_MANAGEMENT]: {
    id: 'feat-admin-mgmt',
    key: FeatureKey.ADMIN_MANAGEMENT,
    name: 'Admin Management',
    description: 'Operator accounts and administrative privilege assignments',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.ADMINISTRATION,
    defaultEnabled: true,
    permissions: [Permissions.ADMINS_MANAGE],
    dependencies: [FeatureKey.USER_MANAGEMENT],
    navigation: {
      path: '/admin/admins',
      showInNav: true,
      navOrder: 18,
      icon: 'user-check',
    },
  },
  [FeatureKey.FEATURE_MANAGEMENT]: {
    id: 'feat-feature-mgmt',
    key: FeatureKey.FEATURE_MANAGEMENT,
    name: 'Feature Management',
    description: 'Centralized registry control, kill-switches, and state overrides',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.ADMINISTRATION,
    defaultEnabled: true,
    permissions: [Permissions.FEATURES_VIEW, Permissions.FEATURES_MANAGE],
    dependencies: [],
    navigation: {
      path: '/admin/features',
      showInNav: true,
      navOrder: 19,
      icon: 'toggle-right',
    },
  },
  [FeatureKey.PERMISSION_MANAGEMENT]: {
    id: 'feat-perm-mgmt',
    key: FeatureKey.PERMISSION_MANAGEMENT,
    name: 'Permission Management',
    description: 'Granular resource-action matrices and role delegations',
    status: FeatureStatus.ACTIVE,
    category: FeatureCategory.ADMINISTRATION,
    defaultEnabled: true,
    permissions: [
      Permissions.PERMISSIONS_VIEW,
      Permissions.PERMISSIONS_MANAGE,
      Permissions.ROLES_VIEW,
      Permissions.ROLES_MANAGE,
    ],
    dependencies: [FeatureKey.FEATURE_MANAGEMENT],
    navigation: {
      path: '/admin/permissions',
      showInNav: true,
      navOrder: 20,
      icon: 'key',
    },
  },
};

/**
 * Returns an array of all registered feature definitions.
 */
export function getAllFeatureDefinitions(): FeatureDefinition[] {
  return Object.values(FEATURE_REGISTRY);
}

/**
 * Returns a feature definition by key or undefined if not found.
 */
export function getFeatureDefinition(key: FeatureKey): FeatureDefinition | undefined {
  return FEATURE_REGISTRY[key];
}

/**
 * Validates feature dependencies.
 * Ensures that a feature's required dependencies are enabled.
 */
export function validateFeatureDependencies(
  key: FeatureKey,
  isFeatureEnabledFn: (k: FeatureKey) => boolean,
): { valid: boolean; unmetDependencies: FeatureKey[] } {
  const definition = FEATURE_REGISTRY[key];
  if (!definition) {
    return { valid: false, unmetDependencies: [] };
  }

  const unmetDependencies = definition.dependencies.filter(
    (dep: FeatureKey) => !isFeatureEnabledFn(dep),
  );

  return {
    valid: unmetDependencies.length === 0,
    unmetDependencies,
  };
}

/**
 * Checks if a feature state allows general access.
 * ACTIVE and BETA are functional; INACTIVE, COMING_SOON, and MAINTENANCE are restricted.
 */
export function isFunctionalStatus(status: FeatureStatus): boolean {
  return (
    status === FeatureStatus.ACTIVE ||
    status === FeatureStatus.BETA ||
    status === FeatureStatus.HIDDEN
  );
}
