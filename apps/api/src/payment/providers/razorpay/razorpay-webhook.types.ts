/**
 * Razorpay Webhook Payload Types
 *
 * Minimal typed representation of the webhook events Vishkaraa processes.
 * We NEVER pass raw Razorpay SDK response objects outside this layer.
 *
 * Reference: https://razorpay.com/docs/webhooks/
 */

export type RazorpayWebhookEventType =
  | 'payment.authorized'
  | 'payment.captured'
  | 'payment.failed'
  | 'order.paid';

export interface RazorpayWebhookPaymentEntity {
  id: string; // Razorpay payment ID (pay_xxx)
  order_id: string; // Razorpay order ID (order_xxx)
  status: string; // 'authorized' | 'captured' | 'failed'
  amount: number; // in paise
  currency: string;
  error_code?: string;
  error_description?: string;
}

export interface RazorpayWebhookPayload {
  entity: 'event';
  account_id: string;
  event: RazorpayWebhookEventType;
  contains: string[];
  payload: {
    payment?: {
      entity: RazorpayWebhookPaymentEntity;
    };
    order?: {
      entity: {
        id: string;
        status: string;
        amount: number;
        currency: string;
      };
    };
  };
  created_at: number; // Unix timestamp
}

/**
 * Parsed, domain-safe representation of a Razorpay webhook event.
 * Used internally after signature verification; not passed to callers with raw provider data.
 */
export interface ParsedRazorpayWebhookEvent {
  eventType: RazorpayWebhookEventType;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  amountPaise: number | null;
  currency: string | null;
  createdAtUnix: number;
}
