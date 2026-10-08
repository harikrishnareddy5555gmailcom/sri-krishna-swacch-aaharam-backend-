/**
 * Audit Log Types
 *
 * Architectural boundary for the Audit module.
 * Full implementation is a future phase.
 *
 * DESIGN PRINCIPLES:
 * - Audit logs are APPEND-ONLY. Never update or delete audit records.
 * - Every significant action (auth, order, return, refund, admin actions) must
 *   produce an audit record.
 * - Records must capture the complete before/after state.
 * - Metadata field allows attaching arbitrary context without schema changes.
 */

export enum AuditAction {
  // Auth actions
  USER_REGISTERED = 'USER_REGISTERED',
  USER_LOGGED_IN = 'USER_LOGGED_IN',
  USER_LOGGED_OUT = 'USER_LOGGED_OUT',
  USER_PASSWORD_CHANGED = 'USER_PASSWORD_CHANGED',
  USER_PASSWORD_RESET_REQUESTED = 'USER_PASSWORD_RESET_REQUESTED',

  // User management
  USER_CREATED = 'USER_CREATED',
  USER_UPDATED = 'USER_UPDATED',
  USER_SUSPENDED = 'USER_SUSPENDED',
  USER_ACTIVATED = 'USER_ACTIVATED',
  USER_ROLE_CHANGED = 'USER_ROLE_CHANGED',

  // Order actions
  ORDER_CREATED = 'ORDER_CREATED',
  ORDER_CONFIRMED = 'ORDER_CONFIRMED',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  ORDER_STATUS_CHANGED = 'ORDER_STATUS_CHANGED',

  // Return actions
  RETURN_REQUESTED = 'RETURN_REQUESTED',
  RETURN_APPROVED = 'RETURN_APPROVED',
  RETURN_REJECTED = 'RETURN_REJECTED',
  RETURN_COMPLETED = 'RETURN_COMPLETED',
  // Phase 10B additional return lifecycle actions
  RETURN_RECEIVED = 'RETURN_RECEIVED',                           // Parcel received at warehouse
  RETURN_INSPECTED = 'RETURN_INSPECTED',                         // Items inspected; quantities recorded
  RETURN_REFUND_REQUESTED = 'RETURN_REFUND_REQUESTED',           // Phase 09 refund triggered after inspection
  RETURN_CANCELLED = 'RETURN_CANCELLED',                         // Customer or admin cancellation

  // Refund lifecycle actions — Phase 09B state machine
  REFUND_REQUESTED = 'REFUND_REQUESTED',                               // Admin submits refund request
  REFUND_APPROVED = 'REFUND_APPROVED',                                 // Approver authorizes request
  REFUND_REJECTED = 'REFUND_REJECTED',                                 // Approver denies request
  REFUND_ATTEMPT_INITIATED = 'REFUND_ATTEMPT_INITIATED',               // Worker dispatches gateway attempt
  REFUND_COMPLETED = 'REFUND_COMPLETED',                               // Gateway confirms settlement
  REFUND_FAILED = 'REFUND_FAILED',                                     // Gateway permanently fails
  REFUND_CANCELLED = 'REFUND_CANCELLED',                               // Admin cancels pending request
  REFUND_RECONCILIATION_REQUIRED = 'REFUND_RECONCILIATION_REQUIRED',   // Timeout/gateway ambiguity flagged
  REFUND_RECONCILED = 'REFUND_RECONCILED',                             // Ambiguity resolved by admin/cron
  // Legacy keys kept for backward compatibility
  REFUND_CREATED = 'REFUND_CREATED',
  PARTIAL_REFUND_CREATED = 'PARTIAL_REFUND_CREATED',

  // Admin actions
  ADMIN_ACTION = 'ADMIN_ACTION',
  FEATURE_UPDATED = 'FEATURE_UPDATED',
  PERMISSION_UPDATED = 'PERMISSION_UPDATED',
  SETTING_CHANGED = 'SETTING_CHANGED',

  // Catalog actions
  CATEGORY_CREATED = 'CATEGORY_CREATED',
  CATEGORY_UPDATED = 'CATEGORY_UPDATED',
  CATEGORY_ARCHIVED = 'CATEGORY_ARCHIVED',
  PRODUCT_CREATED = 'PRODUCT_CREATED',
  PRODUCT_UPDATED = 'PRODUCT_UPDATED',
  PRODUCT_PUBLISHED = 'PRODUCT_PUBLISHED',
  PRODUCT_DEACTIVATED = 'PRODUCT_DEACTIVATED',
  PRODUCT_ARCHIVED = 'PRODUCT_ARCHIVED',
  VARIANT_CREATED = 'VARIANT_CREATED',
  VARIANT_UPDATED = 'VARIANT_UPDATED',
  VARIANT_DEACTIVATED = 'VARIANT_DEACTIVATED',
  MEDIA_ADDED = 'MEDIA_ADDED',
  MEDIA_REMOVED = 'MEDIA_REMOVED',

  // Cart security / lifecycle actions (low-noise, security & integrity only)
  CART_MERGED = 'CART_MERGED',
  CART_MERGE_FAILED = 'CART_MERGE_FAILED',
  CART_SECURITY_VIOLATION = 'CART_SECURITY_VIOLATION',

  // Checkout actions
  CHECKOUT_INITIALIZED = 'CHECKOUT_INITIALIZED',
  CHECKOUT_EXPIRED = 'CHECKOUT_EXPIRED',
  CHECKOUT_CANCELLED = 'CHECKOUT_CANCELLED',
  CHECKOUT_SECURITY_VIOLATION = 'CHECKOUT_SECURITY_VIOLATION',

  // Payment actions
  PAYMENT_ATTEMPT_CREATED = 'PAYMENT_ATTEMPT_CREATED',
  PAYMENT_STATE_CHANGED = 'PAYMENT_STATE_CHANGED',
  PAYMENT_SECURITY_VIOLATION = 'PAYMENT_SECURITY_VIOLATION',
  PAYMENT_AMOUNT_INTEGRITY_VIOLATION = 'PAYMENT_AMOUNT_INTEGRITY_VIOLATION',
  PAYMENT_RECONCILIATION_REQUIRED = 'PAYMENT_RECONCILIATION_REQUIRED',

  // Order finalization — Phase 08A
  // MANDATORY: written inside the same database transaction as the Order row.
  // If this audit cannot be written, the Order transaction must rollback.
  ORDER_FINALIZED = 'ORDER_FINALIZED',
  ORDER_STATUS_CHANGED_ADMIN = 'ORDER_STATUS_CHANGED_ADMIN',

  // Inventory actions — Phase 11
  INVENTORY_INITIALIZED = 'INVENTORY_INITIALIZED',
  INVENTORY_ADJUSTED = 'INVENTORY_ADJUSTED',

  // Billing actions — Phase 12
  INVOICE_ISSUED = 'INVOICE_ISSUED',
  INVOICE_CANCELLED = 'INVOICE_CANCELLED',

  // Shipping actions — Phase 13
  SHIPMENT_CREATED = 'SHIPMENT_CREATED',
  SHIPMENT_STATUS_CHANGED = 'SHIPMENT_STATUS_CHANGED',
  SHIPMENT_CANCELLED = 'SHIPMENT_CANCELLED',
  SHIPMENT_DISPATCHED = 'SHIPMENT_DISPATCHED',
  SHIPMENT_DELIVERED = 'SHIPMENT_DELIVERED',
  SHIPMENT_RECONCILIATION_REQUIRED = 'SHIPMENT_RECONCILIATION_REQUIRED',
  SHIPMENT_RECONCILED = 'SHIPMENT_RECONCILED',
}

export enum AuditEntityType {
  USER = 'USER',
  ORDER = 'ORDER',
  ORDER_ITEM = 'ORDER_ITEM',
  RETURN = 'RETURN',
  RETURN_ITEM = 'RETURN_ITEM',  // Phase 10B
  REFUND = 'REFUND',
  FEATURE = 'FEATURE',
  PERMISSION = 'PERMISSION',
  SETTING = 'SETTING',
  CATEGORY = 'CATEGORY',
  PRODUCT = 'PRODUCT',
  PRODUCT_VARIANT = 'PRODUCT_VARIANT',
  PRODUCT_MEDIA = 'PRODUCT_MEDIA',
  CART = 'CART',
  CHECKOUT = 'CHECKOUT',
  PAYMENT = 'PAYMENT',
  INVENTORY_ITEM = 'INVENTORY_ITEM', // Phase 11
  INVOICE = 'INVOICE',               // Phase 12
  SHIPMENT = 'SHIPMENT',             // Phase 13
  SHIPMENT_ITEM = 'SHIPMENT_ITEM',   // Phase 13
}

/**
 * Core audit log entry.
 * This is the immutable record of a single significant event.
 */
export interface AuditLog {
  id: string;

  /** Who performed the action */
  actorId: string;
  actorRole: string;
  actorEmail?: string;

  /** What happened */
  action: AuditAction;

  /** Which entity was affected */
  entityType: AuditEntityType;
  entityId: string;

  /** Context references */
  orderId?: string;
  userId?: string; // Affected user (may differ from actor)

  /** Financial context */
  amount?: number;
  currency?: string;

  /** State transition */
  previousValue?: string; // JSON string of before-state
  newValue?: string; // JSON string of after-state

  /** Human-readable reason */
  reason?: string;

  /** Request correlation ID for distributed tracing */
  correlationId?: string;

  /** Arbitrary additional context */
  metadata?: Record<string, unknown>;

  /** When it happened (set by the database, not the application) */
  createdAt: Date;
}
