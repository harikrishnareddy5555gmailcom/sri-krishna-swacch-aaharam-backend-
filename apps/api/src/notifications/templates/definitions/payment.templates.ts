import { NotificationChannel, NotificationEventType } from '@vishkaraa/types';
import {
  type NotificationTemplateDefinition,
  type PaymentCapturedContext,
  type PaymentFailedContext,
} from '../notification-template.interface.js';
import { escapeHtml, sanitizeActionUrl } from '../notification-template.security.js';

export const PAYMENT_TEMPLATES: NotificationTemplateDefinition[] = [
  // ─── PAYMENT_CAPTURED: IN_APP ─────────────────────────────────────────────
  {
    templateKey: NotificationEventType.PAYMENT_CAPTURED,
    channel: NotificationChannel.IN_APP,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as PaymentCapturedContext;
      return `Payment Received: #${ctx.orderNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as PaymentCapturedContext;
      return `Payment of ₹${ctx.amount} for order #${ctx.orderNumber} was successfully received.`;
    },
  },
  // ─── PAYMENT_CAPTURED: EMAIL ──────────────────────────────────────────────
  {
    templateKey: NotificationEventType.PAYMENT_CAPTURED,
    channel: NotificationChannel.EMAIL,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as PaymentCapturedContext;
      return `Payment Receipt — Order #${ctx.orderNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as PaymentCapturedContext;
      return `Hello ${ctx.customerName || 'Customer'},\n\nWe have received your payment of ₹${ctx.amount} for order #${ctx.orderNumber}.\n\nThank you for choosing Sri Krishna Swacch Aaharam!\n\nWarm regards,\nThe Sri Krishna Swacch Aaharam Team`;
    },
    renderHtml: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as PaymentCapturedContext;
      const name = escapeHtml(ctx.customerName || 'Customer');
      const orderNo = escapeHtml(ctx.orderNumber);
      const amount = escapeHtml(ctx.amount);
      const method = escapeHtml(ctx.paymentMethod || 'Online Payment');
      return `<div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #15803d;">Payment Received</h2>
  <p>Hello <strong>${name}</strong>,</p>
  <p>We have successfully processed your payment for order <strong>#${orderNo}</strong>.</p>
  <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
    <p style="margin: 0 0 8px 0;"><strong>Amount Paid:</strong> ₹${amount}</p>
    <p style="margin: 0 0 8px 0;"><strong>Payment Method:</strong> ${method}</p>
    <p style="margin: 0;"><strong>Order:</strong> #${orderNo}</p>
  </div>
  <p style="font-size: 13px; color: #64748b;">A formal tax invoice will be made available once your shipment is generated.</p>
</div>`;
    },
  },

  // ─── PAYMENT_FAILED: IN_APP ───────────────────────────────────────────────
  {
    templateKey: NotificationEventType.PAYMENT_FAILED,
    channel: NotificationChannel.IN_APP,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as PaymentFailedContext;
      return `Payment Failed: #${ctx.orderNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as PaymentFailedContext;
      return `Payment attempt of ₹${ctx.amount} for order #${ctx.orderNumber} was not successful. Please retry your payment.`;
    },
  },
  // ─── PAYMENT_FAILED: EMAIL ────────────────────────────────────────────────
  {
    templateKey: NotificationEventType.PAYMENT_FAILED,
    channel: NotificationChannel.EMAIL,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as PaymentFailedContext;
      return `Payment Unsuccessful — Order #${ctx.orderNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as PaymentFailedContext;
      return `Hello ${ctx.customerName || 'Customer'},\n\nYour payment of ₹${ctx.amount} for order #${ctx.orderNumber} could not be processed.${ctx.failureReason ? ` Reason: ${ctx.failureReason}` : ''}\n\nPlease visit your checkout page to retry payment.\n\nWarm regards,\nThe Sri Krishna Swacch Aaharam Team`;
    },
    renderHtml: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as PaymentFailedContext;
      const name = escapeHtml(ctx.customerName || 'Customer');
      const orderNo = escapeHtml(ctx.orderNumber);
      const amount = escapeHtml(ctx.amount);
      const reason = escapeHtml(ctx.failureReason || 'Transaction declined by payment gateway');
      const retryUrl = sanitizeActionUrl(ctx.retryUrl, 'https://vishkaraanaturals.com') ?? `https://vishkaraanaturals.com/checkout`;
      return `<div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #b91c1c;">Payment Failed</h2>
  <p>Hello <strong>${name}</strong>,</p>
  <p>We were unable to process your payment of <strong>₹${amount}</strong> for order <strong>#${orderNo}</strong>.</p>
  <p style="color: #64748b; font-size: 14px;"><strong>Reason:</strong> ${reason}</p>
  <p style="margin: 24px 0;">
    <a href="${retryUrl}" style="background-color: #b91c1c; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold;">Retry Payment</a>
  </p>
  <p style="font-size: 13px; color: #64748b;">If any amount was debited from your bank account, it will be automatically reversed within 3-5 business days.</p>
</div>`;
    },
  },
];
