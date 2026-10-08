import {
  type NotificationChannel,
  type NotificationTemplateDefinition,
  type RenderedNotification,
} from '@vishkaraa/types';

export {
  type NotificationChannel,
  type NotificationTemplateDefinition,
  type RenderedNotification,
};

// ─── Strongly Typed Event Contexts ──────────────────────────────────────────

export interface AuthWelcomeContext extends Record<string, unknown> {
  firstName: string;
  email?: string;
}

export interface AuthPasswordResetContext extends Record<string, unknown> {
  firstName: string;
  resetUrl: string;
  expiresMinutes?: number;
}

export interface OrderContext extends Record<string, unknown> {
  customerName: string;
  orderNumber: string;
  totalAmount: string | number;
  itemCount?: number;
  actionUrl?: string;
}

export interface PaymentCapturedContext extends Record<string, unknown> {
  customerName: string;
  orderNumber: string;
  amount: string | number;
  paymentMethod?: string;
}

export interface PaymentFailedContext extends Record<string, unknown> {
  customerName: string;
  orderNumber: string;
  amount: string | number;
  failureReason?: string;
  retryUrl?: string;
}

export interface ShipmentDispatchedContext extends Record<string, unknown> {
  customerName: string;
  orderNumber: string;
  shipmentNumber: string;
  carrierName: string;
  trackingNumber?: string;
  trackingUrl?: string;
}

export interface ShipmentOutForDeliveryContext extends Record<string, unknown> {
  customerName: string;
  orderNumber: string;
  shipmentNumber: string;
  carrierName?: string;
}

export interface ShipmentDeliveredContext extends Record<string, unknown> {
  customerName: string;
  orderNumber: string;
  shipmentNumber: string;
  deliveredAt?: string;
}

export interface ShipmentFailedContext extends Record<string, unknown> {
  customerName: string;
  orderNumber: string;
  shipmentNumber: string;
  reason?: string;
}

export interface ReturnApprovedContext extends Record<string, unknown> {
  customerName: string;
  returnNumber: string;
  orderNumber: string;
  pickupDate?: string;
}

export interface RefundCompletedContext extends Record<string, unknown> {
  customerName: string;
  refundNumber: string;
  orderNumber: string;
  amount: string | number;
}

export interface InvoiceIssuedContext extends Record<string, unknown> {
  customerName: string;
  invoiceNumber: string;
  orderNumber: string;
  totalAmount: string | number;
  invoiceUrl?: string;
}

export interface ReconciliationRequiredContext extends Record<string, unknown> {
  entityType: string;
  entityId: string;
  discrepancyDetails: string;
  detectedAt?: string;
}
