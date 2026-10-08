import {
  FeatureKey,
  PermissionEffect,
  Permissions,
  UserRole,
  type PermissionDefinition,
  type RolePermissionMapping,
  type UserEffectivePermissions,
  type UserPermissionGrant,
} from '@vishkaraa/types';

/**
 * Authoritative Permission Registry
 *
 * All permissions defined across resources and actions, tied to features,
 * with explicit delegation boundaries (isAssignableToAdmin).
 */
export const PERMISSION_REGISTRY: Record<string, PermissionDefinition> = {
  // Dashboard
  [Permissions.DASHBOARD_VIEW]: {
    id: 'perm-dash-view',
    key: Permissions.DASHBOARD_VIEW,
    resource: 'DASHBOARD',
    action: 'VIEW',
    description: 'View dashboard metrics and analytics overview',
    featureKey: FeatureKey.DASHBOARD,
    isAssignableToAdmin: true,
  },

  // Products
  [Permissions.PRODUCTS_VIEW]: {
    id: 'perm-prod-view',
    key: Permissions.PRODUCTS_VIEW,
    resource: 'PRODUCTS',
    action: 'VIEW',
    description: 'View product listings and details',
    featureKey: FeatureKey.PRODUCTS,
    isAssignableToAdmin: true,
  },
  [Permissions.PRODUCTS_CREATE]: {
    id: 'perm-prod-create',
    key: Permissions.PRODUCTS_CREATE,
    resource: 'PRODUCTS',
    action: 'CREATE',
    description: 'Create new products',
    featureKey: FeatureKey.PRODUCTS,
    isAssignableToAdmin: true,
  },
  [Permissions.PRODUCTS_UPDATE]: {
    id: 'perm-prod-update',
    key: Permissions.PRODUCTS_UPDATE,
    resource: 'PRODUCTS',
    action: 'UPDATE',
    description: 'Update existing products and pricing',
    featureKey: FeatureKey.PRODUCTS,
    isAssignableToAdmin: true,
  },
  [Permissions.PRODUCTS_DELETE]: {
    id: 'perm-prod-delete',
    key: Permissions.PRODUCTS_DELETE,
    resource: 'PRODUCTS',
    action: 'DELETE',
    description: 'Archive or delete products from catalog',
    featureKey: FeatureKey.PRODUCTS,
    isAssignableToAdmin: true,
  },
  [Permissions.PRODUCTS_PUBLISH]: {
    id: 'perm-prod-publish',
    key: Permissions.PRODUCTS_PUBLISH,
    resource: 'PRODUCTS',
    action: 'PUBLISH',
    description: 'Publish or activate products (make publicly visible)',
    featureKey: FeatureKey.PRODUCTS,
    isAssignableToAdmin: true,
  },

  // Product Variants
  [Permissions.PRODUCT_VARIANTS_VIEW]: {
    id: 'perm-var-view',
    key: Permissions.PRODUCT_VARIANTS_VIEW,
    resource: 'PRODUCT_VARIANTS',
    action: 'VIEW',
    description: 'View product variants',
    featureKey: FeatureKey.PRODUCT_VARIANTS,
    isAssignableToAdmin: true,
  },
  [Permissions.PRODUCT_VARIANTS_CREATE]: {
    id: 'perm-var-create',
    key: Permissions.PRODUCT_VARIANTS_CREATE,
    resource: 'PRODUCT_VARIANTS',
    action: 'CREATE',
    description: 'Create new product variants with SKU and pricing',
    featureKey: FeatureKey.PRODUCT_VARIANTS,
    isAssignableToAdmin: true,
  },
  [Permissions.PRODUCT_VARIANTS_UPDATE]: {
    id: 'perm-var-update',
    key: Permissions.PRODUCT_VARIANTS_UPDATE,
    resource: 'PRODUCT_VARIANTS',
    action: 'UPDATE',
    description: 'Update product variant details and pricing',
    featureKey: FeatureKey.PRODUCT_VARIANTS,
    isAssignableToAdmin: true,
  },
  [Permissions.PRODUCT_VARIANTS_DELETE]: {
    id: 'perm-var-delete',
    key: Permissions.PRODUCT_VARIANTS_DELETE,
    resource: 'PRODUCT_VARIANTS',
    action: 'DELETE',
    description: 'Deactivate or delete product variants',
    featureKey: FeatureKey.PRODUCT_VARIANTS,
    isAssignableToAdmin: true,
  },

  // Product Media
  [Permissions.PRODUCT_MEDIA_VIEW]: {
    id: 'perm-media-view',
    key: Permissions.PRODUCT_MEDIA_VIEW,
    resource: 'PRODUCT_MEDIA',
    action: 'VIEW',
    description: 'View product media and images',
    featureKey: FeatureKey.PRODUCT_MEDIA,
    isAssignableToAdmin: true,
  },
  [Permissions.PRODUCT_MEDIA_MANAGE]: {
    id: 'perm-media-manage',
    key: Permissions.PRODUCT_MEDIA_MANAGE,
    resource: 'PRODUCT_MEDIA',
    action: 'MANAGE',
    description: 'Upload, reorder, and remove product media',
    featureKey: FeatureKey.PRODUCT_MEDIA,
    isAssignableToAdmin: true,
  },

  // Categories
  [Permissions.CATEGORIES_VIEW]: {
    id: 'perm-cat-view',
    key: Permissions.CATEGORIES_VIEW,
    resource: 'CATEGORIES',
    action: 'VIEW',
    description: 'View categories',
    featureKey: FeatureKey.CATEGORIES,
    isAssignableToAdmin: true,
  },
  [Permissions.CATEGORIES_CREATE]: {
    id: 'perm-cat-create',
    key: Permissions.CATEGORIES_CREATE,
    resource: 'CATEGORIES',
    action: 'CREATE',
    description: 'Create new product categories',
    featureKey: FeatureKey.CATEGORIES,
    isAssignableToAdmin: true,
  },
  [Permissions.CATEGORIES_UPDATE]: {
    id: 'perm-cat-update',
    key: Permissions.CATEGORIES_UPDATE,
    resource: 'CATEGORIES',
    action: 'UPDATE',
    description: 'Update category details and hierarchy',
    featureKey: FeatureKey.CATEGORIES,
    isAssignableToAdmin: true,
  },
  [Permissions.CATEGORIES_DELETE]: {
    id: 'perm-cat-delete',
    key: Permissions.CATEGORIES_DELETE,
    resource: 'CATEGORIES',
    action: 'DELETE',
    description: 'Archive or deactivate categories',
    featureKey: FeatureKey.CATEGORIES,
    isAssignableToAdmin: true,
  },
  [Permissions.CATEGORIES_MANAGE]: {
    id: 'perm-cat-manage',
    key: Permissions.CATEGORIES_MANAGE,
    resource: 'CATEGORIES',
    action: 'MANAGE',
    description: 'Full category management (create, update, reorder, archive)',
    featureKey: FeatureKey.CATEGORIES,
    isAssignableToAdmin: true,
  },

  // Cart & Checkout
  [Permissions.CART_VIEW]: {
    id: 'perm-cart-view',
    key: Permissions.CART_VIEW,
    resource: 'CART',
    action: 'VIEW',
    description: 'View shopping cart items',
    featureKey: FeatureKey.CART,
    isAssignableToAdmin: true,
  },
  [Permissions.CART_CREATE]: {
    id: 'perm-cart-create',
    key: Permissions.CART_CREATE,
    resource: 'CART',
    action: 'CREATE',
    description: 'Create carts and add items',
    featureKey: FeatureKey.CART,
    isAssignableToAdmin: true,
  },
  [Permissions.CART_UPDATE]: {
    id: 'perm-cart-update',
    key: Permissions.CART_UPDATE,
    resource: 'CART',
    action: 'UPDATE',
    description: 'Update cart item quantities',
    featureKey: FeatureKey.CART,
    isAssignableToAdmin: true,
  },
  [Permissions.CART_DELETE]: {
    id: 'perm-cart-delete',
    key: Permissions.CART_DELETE,
    resource: 'CART',
    action: 'DELETE',
    description: 'Remove items or clear cart',
    featureKey: FeatureKey.CART,
    isAssignableToAdmin: true,
  },
  [Permissions.CART_MANAGE]: {
    id: 'perm-cart-manage',
    key: Permissions.CART_MANAGE,
    resource: 'CART',
    action: 'MANAGE',
    description: 'Add, update, or clear items in cart',
    featureKey: FeatureKey.CART,
    isAssignableToAdmin: true,
  },
  [Permissions.CHECKOUT_VIEW]: {
    id: 'perm-chk-view',
    key: Permissions.CHECKOUT_VIEW,
    resource: 'CHECKOUT',
    action: 'VIEW',
    description: 'View checkout flow',
    featureKey: FeatureKey.CHECKOUT,
    isAssignableToAdmin: true,
  },
  [Permissions.CHECKOUT_MANAGE]: {
    id: 'perm-chk-manage',
    key: Permissions.CHECKOUT_MANAGE,
    resource: 'CHECKOUT',
    action: 'MANAGE',
    description: 'Process checkout and initiate payment',
    featureKey: FeatureKey.CHECKOUT,
    isAssignableToAdmin: true,
  },

  // Orders
  [Permissions.ORDERS_VIEW]: {
    id: 'perm-ord-view',
    key: Permissions.ORDERS_VIEW,
    resource: 'ORDERS',
    action: 'VIEW',
    description: 'View orders',
    featureKey: FeatureKey.ORDERS,
    isAssignableToAdmin: true,
  },
  [Permissions.ORDERS_CREATE]: {
    id: 'perm-ord-create',
    key: Permissions.ORDERS_CREATE,
    resource: 'ORDERS',
    action: 'CREATE',
    description: 'Create new orders',
    featureKey: FeatureKey.ORDERS,
    isAssignableToAdmin: true,
  },
  [Permissions.ORDERS_UPDATE]: {
    id: 'perm-ord-update',
    key: Permissions.ORDERS_UPDATE,
    resource: 'ORDERS',
    action: 'UPDATE',
    description: 'Update order status and fulfillment',
    featureKey: FeatureKey.ORDERS,
    isAssignableToAdmin: true,
  },
  [Permissions.ORDERS_CANCEL]: {
    id: 'perm-ord-cancel',
    key: Permissions.ORDERS_CANCEL,
    resource: 'ORDERS',
    action: 'CANCEL',
    description: 'Cancel pending or processing orders',
    featureKey: FeatureKey.ORDERS,
    isAssignableToAdmin: true,
  },

  // Returns
  [Permissions.RETURNS_VIEW]: {
    id: 'perm-ret-view',
    key: Permissions.RETURNS_VIEW,
    resource: 'RETURNS',
    action: 'VIEW',
    description: 'View return requests',
    featureKey: FeatureKey.RETURNS,
    isAssignableToAdmin: true,
  },
  [Permissions.RETURNS_CREATE]: {
    id: 'perm-ret-create',
    key: Permissions.RETURNS_CREATE,
    resource: 'RETURNS',
    action: 'CREATE',
    description: 'Submit return requests',
    featureKey: FeatureKey.RETURNS,
    isAssignableToAdmin: true,
  },
  [Permissions.RETURNS_APPROVE]: {
    id: 'perm-ret-approve',
    key: Permissions.RETURNS_APPROVE,
    resource: 'RETURNS',
    action: 'APPROVE',
    description: 'Approve return requests and issue return authorization',
    featureKey: FeatureKey.RETURNS,
    isAssignableToAdmin: true,
  },
  [Permissions.RETURNS_REJECT]: {
    id: 'perm-ret-reject',
    key: Permissions.RETURNS_REJECT,
    resource: 'RETURNS',
    action: 'REJECT',
    description: 'Reject return requests with rationale',
    featureKey: FeatureKey.RETURNS,
    isAssignableToAdmin: true,
  },
  [Permissions.RETURNS_INSPECT]: {
    id: 'perm-ret-inspect',
    key: Permissions.RETURNS_INSPECT,
    resource: 'RETURNS',
    action: 'INSPECT',
    description: 'Receive returned packages at warehouse dock and perform item quality inspection',
    featureKey: FeatureKey.RETURNS,
    isAssignableToAdmin: true,
  },
  [Permissions.RETURNS_MANAGE]: {
    id: 'perm-ret-manage',
    key: Permissions.RETURNS_MANAGE,
    resource: 'RETURNS',
    action: 'MANAGE',
    description: 'Manage returns lifecycle, override eligibility windows, and trigger operational cancellations',
    featureKey: FeatureKey.RETURNS,
    isAssignableToAdmin: true,
  },

  // Refunds
  [Permissions.REFUNDS_VIEW]: {
    id: 'perm-ref-view',
    key: Permissions.REFUNDS_VIEW,
    resource: 'REFUNDS',
    action: 'VIEW',
    description: 'View refund transactions',
    featureKey: FeatureKey.REFUNDS,
    isAssignableToAdmin: true,
  },
  [Permissions.REFUNDS_CREATE]: {
    id: 'perm-ref-create',
    key: Permissions.REFUNDS_CREATE,
    resource: 'REFUNDS',
    action: 'CREATE',
    description: 'Initiate refund requests',
    featureKey: FeatureKey.REFUNDS,
    isAssignableToAdmin: true,
  },
  [Permissions.REFUNDS_APPROVE]: {
    id: 'perm-ref-approve',
    key: Permissions.REFUNDS_APPROVE,
    resource: 'REFUNDS',
    action: 'APPROVE',
    description: 'Authorize monetary refund disbursements (High Privilege)',
    featureKey: FeatureKey.REFUNDS,
    isAssignableToAdmin: true, // Assignable, but NOT granted to Admin by default!
  },
  [Permissions.REFUNDS_MANAGE]: {
    id: 'perm-ref-manage',
    key: Permissions.REFUNDS_MANAGE,
    resource: 'REFUNDS',
    action: 'MANAGE',
    description: 'Cancel pending refunds, trigger controlled retry',
    featureKey: FeatureKey.REFUNDS,
    isAssignableToAdmin: true,
  },
  [Permissions.REFUNDS_RECONCILE]: {
    id: 'perm-ref-reconcile',
    key: Permissions.REFUNDS_RECONCILE,
    resource: 'REFUNDS',
    action: 'RECONCILE',
    description: 'Manually resolve ambiguous or timed-out refunds',
    featureKey: FeatureKey.REFUNDS,
    isAssignableToAdmin: true,
  },

  // Inventory
  [Permissions.INVENTORY_VIEW]: {
    id: 'perm-inv-view',
    key: Permissions.INVENTORY_VIEW,
    resource: 'INVENTORY',
    action: 'VIEW',
    description: 'View inventory stock counts',
    featureKey: FeatureKey.INVENTORY,
    isAssignableToAdmin: true,
  },
  [Permissions.INVENTORY_MANAGE]: {
    id: 'perm-inv-manage',
    key: Permissions.INVENTORY_MANAGE,
    resource: 'INVENTORY',
    action: 'MANAGE',
    description: 'Adjust stock levels and reorder thresholds',
    featureKey: FeatureKey.INVENTORY,
    isAssignableToAdmin: true,
  },

  // Finance
  [Permissions.PAYMENTS_VIEW]: {
    id: 'perm-pay-view',
    key: Permissions.PAYMENTS_VIEW,
    resource: 'PAYMENTS',
    action: 'VIEW',
    description: 'View payment receipts and transaction status',
    featureKey: FeatureKey.PAYMENTS,
    isAssignableToAdmin: true,
  },
  [Permissions.PAYMENTS_CREATE]: {
    id: 'perm-pay-create',
    key: Permissions.PAYMENTS_CREATE,
    resource: 'PAYMENTS',
    action: 'CREATE',
    description: 'Create and initialize payment attempts',
    featureKey: FeatureKey.PAYMENTS,
    isAssignableToAdmin: true,
  },
  [Permissions.PAYMENTS_MANAGE]: {
    id: 'perm-pay-manage',
    key: Permissions.PAYMENTS_MANAGE,
    resource: 'PAYMENTS',
    action: 'MANAGE',
    description: 'Manage and update payment records',
    featureKey: FeatureKey.PAYMENTS,
    isAssignableToAdmin: true,
  },
  [Permissions.INVOICES_VIEW]: {
    id: 'perm-inv-view',
    key: Permissions.INVOICES_VIEW,
    resource: 'INVOICES',
    action: 'VIEW',
    description: 'View generated invoices',
    featureKey: FeatureKey.INVOICES,
    isAssignableToAdmin: true,
  },
  [Permissions.INVOICES_MANAGE]: {
    id: 'perm-inv-manage',
    key: Permissions.INVOICES_MANAGE,
    resource: 'INVOICES',
    action: 'MANAGE',
    description: 'Manage and cancel invoices',
    featureKey: FeatureKey.INVOICES,
    isAssignableToAdmin: true,
  },
  [Permissions.FINANCE_VIEW]: {
    id: 'perm-fin-view',
    key: Permissions.FINANCE_VIEW,
    resource: 'FINANCE',
    action: 'VIEW',
    description: 'View financial ledger accounts, transactions, and balances',
    featureKey: FeatureKey.PAYMENTS,
    isAssignableToAdmin: true,
  },
  [Permissions.FINANCE_POST]: {
    id: 'perm-fin-post',
    key: Permissions.FINANCE_POST,
    resource: 'FINANCE',
    action: 'POST',
    description: 'Create and post balanced double-entry financial transactions',
    featureKey: FeatureKey.PAYMENTS,
    isAssignableToAdmin: true,
  },
  [Permissions.FINANCE_MANAGE]: {
    id: 'perm-fin-manage',
    key: Permissions.FINANCE_MANAGE,
    resource: 'FINANCE',
    action: 'MANAGE',
    description: 'Manage chart of accounts (create and deactivate accounts)',
    featureKey: FeatureKey.PAYMENTS,
    isAssignableToAdmin: false,
  },
  [Permissions.FINANCE_VOID]: {
    id: 'perm-fin-void',
    key: Permissions.FINANCE_VOID,
    resource: 'FINANCE',
    action: 'VOID',
    description: 'Void posted financial transactions',
    featureKey: FeatureKey.PAYMENTS,
    isAssignableToAdmin: false,
  },

  // Expenses (Phase 15C)
  [Permissions.EXPENSES_VIEW]: {
    id: 'perm-exp-view',
    key: Permissions.EXPENSES_VIEW,
    resource: 'EXPENSES',
    action: 'VIEW',
    description: 'View expense records and status',
    featureKey: FeatureKey.EXPENSES,
    isAssignableToAdmin: true,
  },
  [Permissions.EXPENSES_CREATE]: {
    id: 'perm-exp-create',
    key: Permissions.EXPENSES_CREATE,
    resource: 'EXPENSES',
    action: 'CREATE',
    description: 'Create draft expenses',
    featureKey: FeatureKey.EXPENSES,
    isAssignableToAdmin: true,
  },
  [Permissions.EXPENSES_UPDATE]: {
    id: 'perm-exp-update',
    key: Permissions.EXPENSES_UPDATE,
    resource: 'EXPENSES',
    action: 'UPDATE',
    description: 'Update draft expense details',
    featureKey: FeatureKey.EXPENSES,
    isAssignableToAdmin: true,
  },
  [Permissions.EXPENSES_SUBMIT]: {
    id: 'perm-exp-submit',
    key: Permissions.EXPENSES_SUBMIT,
    resource: 'EXPENSES',
    action: 'SUBMIT',
    description: 'Submit draft expense for management approval',
    featureKey: FeatureKey.EXPENSES,
    isAssignableToAdmin: true,
  },
  [Permissions.EXPENSES_APPROVE]: {
    id: 'perm-exp-approve',
    key: Permissions.EXPENSES_APPROVE,
    resource: 'EXPENSES',
    action: 'APPROVE',
    description: 'Approve submitted expenses',
    featureKey: FeatureKey.EXPENSES,
    isAssignableToAdmin: true,
  },
  [Permissions.EXPENSES_REJECT]: {
    id: 'perm-exp-reject',
    key: Permissions.EXPENSES_REJECT,
    resource: 'EXPENSES',
    action: 'REJECT',
    description: 'Reject submitted expenses with rationale',
    featureKey: FeatureKey.EXPENSES,
    isAssignableToAdmin: true,
  },
  [Permissions.EXPENSES_POST]: {
    id: 'perm-exp-post',
    key: Permissions.EXPENSES_POST,
    resource: 'EXPENSES',
    action: 'POST',
    description: 'Post approved expense to financial ledger',
    featureKey: FeatureKey.EXPENSES,
    isAssignableToAdmin: true,
  },
  [Permissions.EXPENSES_CANCEL]: {
    id: 'perm-exp-cancel',
    key: Permissions.EXPENSES_CANCEL,
    resource: 'EXPENSES',
    action: 'CANCEL',
    description: 'Cancel unposted expenses',
    featureKey: FeatureKey.EXPENSES,
    isAssignableToAdmin: true,
  },
  [Permissions.EXPENSES_MANAGE]: {
    id: 'perm-exp-manage',
    key: Permissions.EXPENSES_MANAGE,
    resource: 'EXPENSES',
    action: 'MANAGE',
    description: 'Full administrative control over expenses',
    featureKey: FeatureKey.EXPENSES,
    isAssignableToAdmin: false,
  },

  // Shipping & Fulfillment (Phase 13)
  [Permissions.SHIPPING_VIEW]: {
    id: 'perm-shp-view',
    key: Permissions.SHIPPING_VIEW,
    resource: 'SHIPPING',
    action: 'VIEW',
    description: 'View shipments, tracking telemetry, and fulfillment queue',
    featureKey: FeatureKey.SHIPPING,
    isAssignableToAdmin: true,
  },
  [Permissions.SHIPPING_CREATE]: {
    id: 'perm-shp-create',
    key: Permissions.SHIPPING_CREATE,
    resource: 'SHIPPING',
    action: 'CREATE',
    description: 'Pack parcels and create shipments',
    featureKey: FeatureKey.SHIPPING,
    isAssignableToAdmin: true,
  },
  [Permissions.SHIPPING_UPDATE]: {
    id: 'perm-shp-update',
    key: Permissions.SHIPPING_UPDATE,
    resource: 'SHIPPING',
    action: 'UPDATE',
    description: 'Update shipment dimensions, weights, and courier metadata',
    featureKey: FeatureKey.SHIPPING,
    isAssignableToAdmin: true,
  },
  [Permissions.SHIPPING_CANCEL]: {
    id: 'perm-shp-cancel',
    key: Permissions.SHIPPING_CANCEL,
    resource: 'SHIPPING',
    action: 'CANCEL',
    description: 'Cancel pre-dispatch shipments',
    featureKey: FeatureKey.SHIPPING,
    isAssignableToAdmin: true,
  },
  [Permissions.SHIPPING_OVERRIDE]: {
    id: 'perm-shp-override',
    key: Permissions.SHIPPING_OVERRIDE,
    resource: 'SHIPPING',
    action: 'OVERRIDE',
    description: 'Administrative break-glass status alteration (mandatory reason)',
    featureKey: FeatureKey.SHIPPING,
    isAssignableToAdmin: true,
  },
  [Permissions.SHIPPING_RECONCILE]: {
    id: 'perm-shp-reconcile',
    key: Permissions.SHIPPING_RECONCILE,
    resource: 'SHIPPING',
    action: 'RECONCILE',
    description: 'Resolve ambiguous courier status discrepancies',
    featureKey: FeatureKey.SHIPPING,
    isAssignableToAdmin: true,
  },

  // Notifications (Phase 14)
  [Permissions.NOTIFICATIONS_VIEW]: {
    id: 'perm-notif-view',
    key: Permissions.NOTIFICATIONS_VIEW,
    resource: 'NOTIFICATIONS',
    action: 'VIEW',
    description: 'View in-app notifications and operational delivery logs',
    featureKey: FeatureKey.NOTIFICATIONS,
    isAssignableToAdmin: true,
  },
  [Permissions.NOTIFICATIONS_MANAGE]: {
    id: 'perm-notif-manage',
    key: Permissions.NOTIFICATIONS_MANAGE,
    resource: 'NOTIFICATIONS',
    action: 'MANAGE',
    description: 'Manage notification configurations and operational alerts',
    featureKey: FeatureKey.NOTIFICATIONS,
    isAssignableToAdmin: true,
  },
  [Permissions.NOTIFICATIONS_RETRY]: {
    id: 'perm-notif-retry',
    key: Permissions.NOTIFICATIONS_RETRY,
    resource: 'NOTIFICATIONS',
    action: 'RETRY',
    description: 'Manually re-trigger failed notification deliveries',
    featureKey: FeatureKey.NOTIFICATIONS,
    isAssignableToAdmin: true,
  },
  [Permissions.NOTIFICATIONS_TEMPLATES]: {
    id: 'perm-notif-templates',
    key: Permissions.NOTIFICATIONS_TEMPLATES,
    resource: 'NOTIFICATIONS',
    action: 'TEMPLATES',
    description: 'Inspect notification template definitions',
    featureKey: FeatureKey.NOTIFICATIONS,
    isAssignableToAdmin: true,
  },

  [Permissions.REPORTS_VIEW]: {
    id: 'perm-rep-view',
    key: Permissions.REPORTS_VIEW,
    resource: 'REPORTS',
    action: 'VIEW',
    description: 'View analytical reports and sales graphs',
    featureKey: FeatureKey.REPORTS,
    isAssignableToAdmin: true,
  },

  // Users & Admins
  [Permissions.USERS_VIEW]: {
    id: 'perm-usr-view',
    key: Permissions.USERS_VIEW,
    resource: 'USERS',
    action: 'VIEW',
    description: 'View user accounts directory',
    featureKey: FeatureKey.USER_MANAGEMENT,
    isAssignableToAdmin: true,
  },
  [Permissions.USERS_UPDATE]: {
    id: 'perm-usr-update',
    key: Permissions.USERS_UPDATE,
    resource: 'USERS',
    action: 'UPDATE',
    description: 'Update user status and profile fields',
    featureKey: FeatureKey.USER_MANAGEMENT,
    isAssignableToAdmin: true,
  },
  [Permissions.ADMINS_MANAGE]: {
    id: 'perm-adm-manage',
    key: Permissions.ADMINS_MANAGE,
    resource: 'ADMINS',
    action: 'MANAGE',
    description: 'Manage admin accounts (Super Admin Boundary)',
    featureKey: FeatureKey.ADMIN_MANAGEMENT,
    isAssignableToAdmin: false, // RESTRICTED to SUPER_ADMIN
  },

  // System & Governance
  [Permissions.AUDIT_LOGS_VIEW]: {
    id: 'perm-aud-view',
    key: Permissions.AUDIT_LOGS_VIEW,
    resource: 'AUDIT_LOGS',
    action: 'VIEW',
    description: 'Inspect immutable security audit log',
    featureKey: FeatureKey.AUDIT_LOGS,
    isAssignableToAdmin: true,
  },
  [Permissions.SETTINGS_VIEW]: {
    id: 'perm-set-view',
    key: Permissions.SETTINGS_VIEW,
    resource: 'SETTINGS',
    action: 'VIEW',
    description: 'View system settings',
    featureKey: FeatureKey.SETTINGS,
    isAssignableToAdmin: true,
  },
  [Permissions.SETTINGS_MANAGE]: {
    id: 'perm-set-manage',
    key: Permissions.SETTINGS_MANAGE,
    resource: 'SETTINGS',
    action: 'MANAGE',
    description: 'Configure platform parameters',
    featureKey: FeatureKey.SETTINGS,
    isAssignableToAdmin: false, // RESTRICTED to SUPER_ADMIN
  },

  // Registry & Permissions (Super Admin Boundary)
  [Permissions.FEATURES_VIEW]: {
    id: 'perm-feat-view',
    key: Permissions.FEATURES_VIEW,
    resource: 'FEATURES',
    action: 'VIEW',
    description: 'View feature registry definitions and status',
    featureKey: FeatureKey.FEATURE_MANAGEMENT,
    isAssignableToAdmin: true,
  },
  [Permissions.FEATURES_MANAGE]: {
    id: 'perm-feat-manage',
    key: Permissions.FEATURES_MANAGE,
    resource: 'FEATURES',
    action: 'MANAGE',
    description: 'Modify feature statuses and overrides (Super Admin Boundary)',
    featureKey: FeatureKey.FEATURE_MANAGEMENT,
    isAssignableToAdmin: false, // RESTRICTED to SUPER_ADMIN
  },
  [Permissions.PERMISSIONS_VIEW]: {
    id: 'perm-prm-view',
    key: Permissions.PERMISSIONS_VIEW,
    resource: 'PERMISSIONS',
    action: 'VIEW',
    description: 'View permission matrix and role assignments',
    featureKey: FeatureKey.PERMISSION_MANAGEMENT,
    isAssignableToAdmin: true,
  },
  [Permissions.PERMISSIONS_MANAGE]: {
    id: 'perm-prm-manage',
    key: Permissions.PERMISSIONS_MANAGE,
    resource: 'PERMISSIONS',
    action: 'MANAGE',
    description: 'Grant or revoke permissions (Super Admin Boundary)',
    featureKey: FeatureKey.PERMISSION_MANAGEMENT,
    isAssignableToAdmin: false, // RESTRICTED to SUPER_ADMIN
  },
  [Permissions.ROLES_VIEW]: {
    id: 'perm-rol-view',
    key: Permissions.ROLES_VIEW,
    resource: 'ROLES',
    action: 'VIEW',
    description: 'View roles and their permission mappings',
    featureKey: FeatureKey.PERMISSION_MANAGEMENT,
    isAssignableToAdmin: true,
  },
  [Permissions.ROLES_MANAGE]: {
    id: 'perm-rol-manage',
    key: Permissions.ROLES_MANAGE,
    resource: 'ROLES',
    action: 'MANAGE',
    description: 'Configure role permission baselines (Super Admin Boundary)',
    featureKey: FeatureKey.PERMISSION_MANAGEMENT,
    isAssignableToAdmin: false, // RESTRICTED to SUPER_ADMIN
  },
};

/**
 * Default baseline permissions assigned to roles.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  [UserRole.SUPER_ADMIN]: Object.values(Permissions),

  [UserRole.ADMIN]: [
    Permissions.DASHBOARD_VIEW,

    // Catalog: Products
    Permissions.PRODUCTS_VIEW,
    Permissions.PRODUCTS_CREATE,
    Permissions.PRODUCTS_UPDATE,
    Permissions.PRODUCTS_DELETE,
    Permissions.PRODUCTS_PUBLISH,

    // Catalog: Product Variants
    Permissions.PRODUCT_VARIANTS_VIEW,
    Permissions.PRODUCT_VARIANTS_CREATE,
    Permissions.PRODUCT_VARIANTS_UPDATE,
    Permissions.PRODUCT_VARIANTS_DELETE,

    // Catalog: Product Media
    Permissions.PRODUCT_MEDIA_VIEW,
    Permissions.PRODUCT_MEDIA_MANAGE,

    // Catalog: Categories
    Permissions.CATEGORIES_VIEW,
    Permissions.CATEGORIES_CREATE,
    Permissions.CATEGORIES_UPDATE,
    Permissions.CATEGORIES_DELETE,
    Permissions.CATEGORIES_MANAGE,

    // Cart & Checkout
    Permissions.CART_VIEW,
    Permissions.CART_CREATE,
    Permissions.CART_UPDATE,
    Permissions.CART_DELETE,
    Permissions.CART_MANAGE,

    // Orders & Fulfillment
    Permissions.ORDERS_VIEW,
    Permissions.ORDERS_UPDATE,
    Permissions.ORDERS_CANCEL,
    Permissions.RETURNS_VIEW,
    Permissions.RETURNS_APPROVE,
    Permissions.RETURNS_REJECT,
    Permissions.RETURNS_INSPECT,
    Permissions.RETURNS_MANAGE,
    Permissions.REFUNDS_VIEW,
    // Note: REFUNDS.CREATE and REFUNDS.APPROVE are NOT default!
    // Shipping & Fulfillment (Phase 13)
    Permissions.SHIPPING_VIEW,
    Permissions.SHIPPING_CREATE,
    Permissions.SHIPPING_UPDATE,
    Permissions.SHIPPING_CANCEL,
    Permissions.SHIPPING_RECONCILE,
    // Notifications (Phase 14)
    Permissions.NOTIFICATIONS_VIEW,
    // Expenses (Phase 15C)
    Permissions.EXPENSES_VIEW,
    Permissions.EXPENSES_CREATE,
    Permissions.EXPENSES_UPDATE,
    Permissions.EXPENSES_SUBMIT,
    Permissions.INVENTORY_VIEW,
    Permissions.PAYMENTS_VIEW,
    Permissions.REPORTS_VIEW,
    Permissions.USERS_VIEW,
    Permissions.AUDIT_LOGS_VIEW,
    Permissions.SETTINGS_VIEW,
    Permissions.FEATURES_VIEW,
    Permissions.PERMISSIONS_VIEW,
    Permissions.ROLES_VIEW,
  ],

  [UserRole.USER]: [
    Permissions.DASHBOARD_VIEW,
    Permissions.PRODUCTS_VIEW,
    Permissions.CATEGORIES_VIEW,
    Permissions.CART_VIEW,
    Permissions.CART_CREATE,
    Permissions.CART_UPDATE,
    Permissions.CART_DELETE,
    Permissions.CART_MANAGE,
    Permissions.CHECKOUT_VIEW,
    Permissions.CHECKOUT_MANAGE,
    Permissions.ORDERS_VIEW,
    Permissions.ORDERS_CREATE,
    Permissions.ORDERS_CANCEL,
    Permissions.RETURNS_VIEW,
    Permissions.RETURNS_CREATE,
    Permissions.SHIPPING_VIEW,
    Permissions.REFUNDS_VIEW,
    Permissions.PAYMENTS_VIEW,
    Permissions.PAYMENTS_CREATE,
    Permissions.NOTIFICATIONS_VIEW,
  ],
};

/**
 * Checks if a permission is delegable to Admins.
 * Enforces the Super Admin security boundary.
 */
export function isPermissionAssignableToAdmin(permissionKey: string): boolean {
  const definition = PERMISSION_REGISTRY[permissionKey];
  return definition ? definition.isAssignableToAdmin : false;
}

/**
 * Hierarchical Permission Evaluation Engine
 *
 * Evaluates the effective permissions for a user given:
 * 1. User's role
 * 2. Role permission baseline (optional overrides from DB)
 * 3. Direct user permission grants / denials
 */
export function evaluateEffectivePermissions(params: {
  userId: string;
  role: UserRole;
  rolePermissions?: RolePermissionMapping[];
  userPermissions?: UserPermissionGrant[];
}): UserEffectivePermissions {
  const { userId, role, rolePermissions, userPermissions } = params;

  // Super Admin: platform-wide permissions by design
  if (role === UserRole.SUPER_ADMIN) {
    const allAllowed = Object.values(Permissions);
    return {
      userId,
      role,
      allowed: allAllowed,
      denied: [],
      isSuperAdmin: true,
    };
  }

  const allowedSet = new Set<string>();
  const deniedSet = new Set<string>();

  // 1. Role baseline permissions
  if (rolePermissions && rolePermissions.length > 0) {
    for (const rp of rolePermissions) {
      if (rp.roleName === role) {
        if (rp.effect === PermissionEffect.ALLOW) {
          allowedSet.add(rp.permissionKey);
        } else if (rp.effect === PermissionEffect.DENY) {
          deniedSet.add(rp.permissionKey);
        }
      }
    }
  } else {
    // Fall back to default role baseline
    const defaults = DEFAULT_ROLE_PERMISSIONS[role] || [];
    for (const p of defaults) {
      allowedSet.add(p);
    }
  }

  // 2. Direct user permission grants / denials (User overrides Role)
  if (userPermissions && userPermissions.length > 0) {
    for (const up of userPermissions) {
      if (up.userId === userId) {
        if (up.effect === PermissionEffect.ALLOW) {
          allowedSet.add(up.permissionKey);
          deniedSet.delete(up.permissionKey);
        } else if (up.effect === PermissionEffect.DENY) {
          deniedSet.add(up.permissionKey);
          allowedSet.delete(up.permissionKey);
        }
      }
    }
  }

  // Final pass: explicit denials always override
  for (const d of deniedSet) {
    allowedSet.delete(d);
  }

  return {
    userId,
    role,
    allowed: Array.from(allowedSet),
    denied: Array.from(deniedSet),
    isSuperAdmin: false,
  };
}

/**
 * Checks if a specific permission is granted within an allowed set.
 */
export function canPerform(
  allowedPermissions: Set<string> | string[],
  requiredPermission: string,
): boolean {
  if (Array.isArray(allowedPermissions)) {
    return allowedPermissions.includes(requiredPermission) || allowedPermissions.includes('*');
  }
  return allowedPermissions.has(requiredPermission) || allowedPermissions.has('*');
}
