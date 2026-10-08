import { NotificationChannel, NotificationEventType } from '@vishkaraa/types';
import {
  type NotificationTemplateDefinition,
  type OrderContext,
} from '../notification-template.interface.js';
import { escapeHtml, sanitizeActionUrl } from '../notification-template.security.js';

export const ORDER_TEMPLATES: NotificationTemplateDefinition[] = [
  // ─── ADMIN_NEW_ORDER: IN_APP ───────────────────────────────────────────────
  {
    templateKey: 'ADMIN_NEW_ORDER',
    channel: NotificationChannel.IN_APP,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const orderNo = String(rawCtx['orderNumber'] || '');
      const amount = String(rawCtx['totalAmount'] || '');
      return `🎉 New Order Placed: #${orderNo} (₹${amount})`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const orderNo = String(rawCtx['orderNumber'] || '');
      const customer = String(rawCtx['customerName'] || 'Customer');
      const amount = String(rawCtx['totalAmount'] || '');
      const time = String(rawCtx['orderTime'] || new Date().toLocaleTimeString());
      return `Order #${orderNo} placed by ${customer} for ₹${amount} at ${time}. Click to review fulfillment details.`;
    },
  },
  // ─── ORDER_CONFIRMED: IN_APP ──────────────────────────────────────────────
  {
    templateKey: NotificationEventType.ORDER_CONFIRMED,
    channel: NotificationChannel.IN_APP,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as OrderContext;
      return `Order Confirmed: #${ctx.orderNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as OrderContext;
      return `Your order #${ctx.orderNumber} for ₹${ctx.totalAmount} has been confirmed and is being processed.`;
    },
  },
  // ─── ORDER_CONFIRMED: EMAIL ───────────────────────────────────────────────
  {
    templateKey: NotificationEventType.ORDER_CONFIRMED,
    channel: NotificationChannel.EMAIL,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as OrderContext;
      return `Order Confirmation — #${ctx.orderNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as OrderContext;
      return `Hello ${ctx.customerName || 'Customer'},\n\nThank you for ordering with Sri Krishna Swacch Aaharam! Your order #${ctx.orderNumber} for ₹${ctx.totalAmount} has been confirmed.\n\nWe will notify you once your order is dispatched.\n\nWarm regards,\nThe Sri Krishna Swacch Aaharam Team`;
    },
    renderHtml: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as OrderContext;
      const name = escapeHtml(ctx.customerName || 'Customer');
      const orderNo = escapeHtml(ctx.orderNumber);
      const amount = escapeHtml(ctx.totalAmount);
      const actionUrl = sanitizeActionUrl(ctx.actionUrl, 'https://vishkaraanaturals.com') ?? `https://vishkaraanaturals.com/orders/${orderNo}`;
      return `<div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #15803d;">Order Confirmed!</h2>
  <p>Hello <strong>${name}</strong>,</p>
  <p>We are delighted to confirm your order <strong>#${orderNo}</strong>.</p>
  <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
    <p style="margin: 0 0 8px 0;"><strong>Order Number:</strong> #${orderNo}</p>
    <p style="margin: 0;"><strong>Total Amount:</strong> ₹${amount}</p>
  </div>
  <p style="margin: 24px 0;">
    <a href="${actionUrl}" style="background-color: #15803d; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold;">View Order Details</a>
  </p>
  <p style="font-size: 13px; color: #64748b;">We will notify you as soon as your items are on the way.</p>
</div>`;
    },
  },
  // ─── ORDER_CONFIRMED: SMS ─────────────────────────────────────────────────
  {
    templateKey: NotificationEventType.ORDER_CONFIRMED,
    channel: NotificationChannel.SMS,
    version: 'v1',
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as OrderContext;
      return `Sri Krishna Swacch Aaharam: Your order #${ctx.orderNumber} for Rs.${ctx.totalAmount} is confirmed. We will notify you once dispatched.`;
    },
  },

  // ─── ORDER_CANCELLED: IN_APP ──────────────────────────────────────────────
  {
    templateKey: NotificationEventType.ORDER_CANCELLED,
    channel: NotificationChannel.IN_APP,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as OrderContext;
      return `Order Cancelled: #${ctx.orderNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as OrderContext;
      return `Your order #${ctx.orderNumber} has been cancelled. Any eligible refund will be processed promptly.`;
    },
  },
  // ─── ORDER_CANCELLED: EMAIL ───────────────────────────────────────────────
  {
    templateKey: NotificationEventType.ORDER_CANCELLED,
    channel: NotificationChannel.EMAIL,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as OrderContext;
      return `Order Cancellation Notice — #${ctx.orderNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as OrderContext;
      return `Hello ${ctx.customerName || 'Customer'},\n\nYour order #${ctx.orderNumber} has been cancelled.\n\nIf you made a payment, your refund will be credited back to your original payment method in 5-7 business days.\n\nWarm regards,\nThe Sri Krishna Swacch Aaharam Team`;
    },
    renderHtml: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as OrderContext;
      const name = escapeHtml(ctx.customerName || 'Customer');
      const orderNo = escapeHtml(ctx.orderNumber);
      return `<div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #b91c1c;">Order Cancellation Notice</h2>
  <p>Hello <strong>${name}</strong>,</p>
  <p>Your order <strong>#${orderNo}</strong> has been cancelled.</p>
  <p>If payment was already deducted, an automated refund will be initiated to your source account within 5-7 working days.</p>
  <p style="margin-top: 24px; color: #64748b; font-size: 13px;">If you have any questions, please reach out to our support team.</p>
</div>`;
    },
  },
  // ─── ORDER_CANCELLED: SMS ─────────────────────────────────────────────────
  {
    templateKey: NotificationEventType.ORDER_CANCELLED,
    channel: NotificationChannel.SMS,
    version: 'v1',
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as OrderContext;
      return `Sri Krishna Swacch Aaharam: Your order #${ctx.orderNumber} has been cancelled. Any eligible refund will be credited within 5-7 days.`;
    },
  },
];
