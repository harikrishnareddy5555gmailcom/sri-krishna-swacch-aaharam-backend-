/**
 * Order Types — Phase 08A
 *
 * Order Lifecycle (Phase 08 minimal set):
 *
 *   CONFIRMED    — Order created from CAPTURED payment; default/only creation state.
 *                  Orders are never created with PENDING status.
 *   CANCELLED    — Cancelled before fulfilment (admin or system only).
 *   PROCESSING   — Fulfilment team acknowledged (Phase 09 scope).
 *   SHIPPED      — Carrier assigned (Phase 09 scope).
 *   DELIVERED    — Delivery confirmed (Phase 09 scope).
 *
 * Deferred to Phase 09+:
 *   RETURN_REQUESTED, RETURNED, REFUND_PENDING, PARTIALLY_REFUNDED, REFUNDED
 */

export enum OrderStatus {
  CONFIRMED  = 'CONFIRMED',
  CANCELLED  = 'CANCELLED',
  PROCESSING = 'PROCESSING',
  SHIPPED    = 'SHIPPED',
  DELIVERED  = 'DELIVERED',
}

/** Immutable shipping address snapshot on an Order */
export interface OrderShippingAddress {
  name?: string | null;
  phone?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

/** Shipping address input — accepted at checkout time */
export interface ShippingAddressInput {
  name: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2, e.g. "IN" */
  country: string;
}

/** Immutable order line item — sourced from CheckoutItemSnapshot at finalization */
export interface OrderItemDto {
  id: string;
  orderId: string;
  productId: string | null;    // Soft reference — may be null if product was deleted
  variantId: string | null;    // Soft reference — may be null if variant discontinued
  productName: string;         // Authoritative snapshot
  variantName: string;         // Authoritative snapshot (e.g. "500ml")
  productSku: string;          // Authoritative snapshot
  primaryImageUrl?: string | null;
  quantity: number;
  unitPrice: number;           // Paise
  lineTotal: number;           // Paise (= quantity * unitPrice)
  currency: string;
  createdAt: string;
}

/** Full order DTO — returned by GET /orders/:id */
export interface OrderDto {
  id: string;
  orderNumber: string;         // e.g. "VN-202609-4A7F3B2E"
  userId: string;
  checkoutSessionId: string;
  paymentAttemptId: string;
  status: OrderStatus;

  // Monetary snapshot (all paise)
  subtotal: number;
  tax: number;
  discount: number;
  totalAmount: number;
  currency: string;

  // Immutable shipping snapshot
  shipping: OrderShippingAddress;

  items: OrderItemDto[];

  confirmedAt: string | null;
  cancelledAt: string | null;
  deliveredAt?: string | null;
  cancellationRequestedAt?: string | null | undefined;
  cancellationReason?: string | null | undefined;
  cancellationApprovedAt?: string | null | undefined;
  cancellationRejectedAt?: string | null | undefined;
  cancellationAdminNotes?: string | null | undefined;
  notes?: string | null | undefined;
  payment?: UserOrderPaymentSummary | null | undefined;
  createdAt: string;
  updatedAt: string;
}

/** Provider-independent safe payment summary for customers */
export interface UserOrderPaymentSummary {
  status: string;
  amount: number; // in paise
  currency: string;
  paidAt: string | null;
}

/** Item preview for user order list cards */
export interface UserOrderItemPreviewDto {
  productName: string;
  variantName: string;
  quantity: number;
  primaryImageUrl?: string | null | undefined;
}

/** Lean item for customer order listing */
export interface UserOrderListItemDto {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  totalAmount: number;
  subtotal: number;
  tax: number;
  discount: number;
  currency: string;
  itemCount: number;
  itemsPreview: UserOrderItemPreviewDto[];
  payment?: UserOrderPaymentSummary | null | undefined;
  confirmedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

/** Paginated order list response */
export interface OrderListDto {
  orders: OrderDto[];
  total: number;
  page: number;
  limit: number;
}

/** Privileged operational payment summary for administrators */
export interface AdminOrderPaymentSummary {
  paymentAttemptId: string;
  checkoutSessionId: string;
  provider: string; // e.g. "RAZORPAY", "MOCK"
  providerOrderId?: string | null | undefined;
  providerPaymentId?: string | null | undefined;
  status: string;
  amount: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

/** Customer summary for admin order views */
export interface AdminCustomerSummary {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

/** Lean item for admin order list data table */
export interface AdminOrderListItemDto {
  id: string;
  orderNumber: string;
  userId: string;
  customer?: AdminCustomerSummary | null | undefined;
  status: OrderStatus;
  totalAmount: number;
  currency: string;
  itemCount: number;
  shippingCity?: string | null | undefined;
  shippingState?: string | null | undefined;
  items?: Array<{
    id: string;
    productName: string;
    variantName?: string | null | undefined;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    productSku?: string | null | undefined;
    primaryImageUrl?: string | null | undefined;
  }> | undefined;
  createdAt: string;
  confirmedAt?: string | null | undefined;
  cancelledAt?: string | null | undefined;
}

/** Paginated admin order list response */
export interface AdminOrderListDto {
  orders: AdminOrderListItemDto[];
  total: number;
  page: number;
  limit: number;
}

/** Audit entry for admin order inspection */
export interface AdminOrderAuditItemDto {
  id: string;
  action: string;
  actorRole: string;
  actorEmail?: string | null | undefined;
  previousValue?: string | null | undefined;
  newValue?: string | null | undefined;
  reason?: string | null | undefined;
  createdAt: string;
}

/** Detailed admin order response with operational references and audit history */
export interface AdminOrderDetailDto extends OrderDto {
  customer?: AdminCustomerSummary | null | undefined;
  operationalPayment?: AdminOrderPaymentSummary | null | undefined;
  auditTrail?: AdminOrderAuditItemDto[] | undefined;
}

/** Input for admin status transitions */
export interface UpdateOrderStatusInput {
  status: OrderStatus;
  reason?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface CancelOrderRequestInput {
  reason: string;
}

export interface AdminReviewCancellationInput {
  approved: boolean;
  notes?: string;
}
