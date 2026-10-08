import { NotificationChannel, NotificationEventType } from '@vishkaraa/types';
import {
  type NotificationTemplateDefinition,
  type ReturnApprovedContext,
  type RefundCompletedContext,
} from '../notification-template.interface.js';
import { escapeHtml } from '../notification-template.security.js';

export const RETURN_REFUND_TEMPLATES: NotificationTemplateDefinition[] = [
  // ─── RETURN_APPROVED: IN_APP ──────────────────────────────────────────────
  {
    templateKey: NotificationEventType.RETURN_APPROVED,
    channel: NotificationChannel.IN_APP,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ReturnApprovedContext;
      return `Return Request Approved: #${ctx.returnNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ReturnApprovedContext;
      return `Your return request #${ctx.returnNumber} for order #${ctx.orderNumber} has been approved.${ctx.pickupDate ? ` Pickup scheduled for: ${ctx.pickupDate}.` : ' Reverse pickup will be coordinated shortly.'}`;
    },
  },
  // ─── RETURN_APPROVED: EMAIL ───────────────────────────────────────────────
  {
    templateKey: NotificationEventType.RETURN_APPROVED,
    channel: NotificationChannel.EMAIL,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ReturnApprovedContext;
      return `Return Request Approved — #${ctx.returnNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ReturnApprovedContext;
      return `Hello ${ctx.customerName || 'Customer'},\n\nYour return request #${ctx.returnNumber} for order #${ctx.orderNumber} has been approved.\n\nOur courier partner will arrange pickup of the returned items.${ctx.pickupDate ? ` Scheduled Date: ${ctx.pickupDate}` : ''}\n\nWarm regards,\nThe Sri Krishna Swacch Aaharam Team`;
    },
    renderHtml: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ReturnApprovedContext;
      const name = escapeHtml(ctx.customerName || 'Customer');
      const retNo = escapeHtml(ctx.returnNumber);
      const orderNo = escapeHtml(ctx.orderNumber);
      const pickup = escapeHtml(ctx.pickupDate || 'To be communicated shortly');
      return `<div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #15803d;">Return Request Approved</h2>
  <p>Hello <strong>${name}</strong>,</p>
  <p>Your return request <strong>#${retNo}</strong> for order <strong>#${orderNo}</strong> has been approved by our team.</p>
  <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
    <p style="margin: 0 0 8px 0;"><strong>Return ID:</strong> #${retNo}</p>
    <p style="margin: 0;"><strong>Pickup Coordination:</strong> ${pickup}</p>
  </div>
  <p style="font-size: 13px; color: #64748b;">Please ensure products are packed in original condition with intact seals.</p>
</div>`;
    },
  },
  // ─── RETURN_APPROVED: SMS ─────────────────────────────────────────────────
  {
    templateKey: NotificationEventType.RETURN_APPROVED,
    channel: NotificationChannel.SMS,
    version: 'v1',
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ReturnApprovedContext;
      return `Sri Krishna Swacch Aaharam: Return #${ctx.returnNumber} for order #${ctx.orderNumber} is approved. Reverse pickup will be coordinated shortly.`;
    },
  },

  // ─── REFUND_COMPLETED: IN_APP ─────────────────────────────────────────────
  {
    templateKey: NotificationEventType.REFUND_COMPLETED,
    channel: NotificationChannel.IN_APP,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as RefundCompletedContext;
      return `Refund Processed: #${ctx.refundNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as RefundCompletedContext;
      return `Your refund #${ctx.refundNumber} of ₹${ctx.amount} for order #${ctx.orderNumber} has been successfully completed.`;
    },
  },
  // ─── REFUND_COMPLETED: EMAIL ──────────────────────────────────────────────
  {
    templateKey: NotificationEventType.REFUND_COMPLETED,
    channel: NotificationChannel.EMAIL,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as RefundCompletedContext;
      return `Refund Completed — #${ctx.refundNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as RefundCompletedContext;
      return `Hello ${ctx.customerName || 'Customer'},\n\nWe have successfully processed your refund #${ctx.refundNumber} for ₹${ctx.amount} on order #${ctx.orderNumber}.\n\nThe funds should reflect in your source account within 5-7 business days depending on your bank.\n\nWarm regards,\nThe Sri Krishna Swacch Aaharam Team`;
    },
    renderHtml: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as RefundCompletedContext;
      const name = escapeHtml(ctx.customerName || 'Customer');
      const refNo = escapeHtml(ctx.refundNumber);
      const orderNo = escapeHtml(ctx.orderNumber);
      const amount = escapeHtml(ctx.amount);
      return `<div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #15803d;">Refund Completed</h2>
  <p>Hello <strong>${name}</strong>,</p>
  <p>Your refund for order <strong>#${orderNo}</strong> has been successfully credited.</p>
  <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
    <p style="margin: 0 0 8px 0;"><strong>Refund ID:</strong> #${refNo}</p>
    <p style="margin: 0;"><strong>Amount Refunded:</strong> ₹${amount}</p>
  </div>
  <p style="font-size: 13px; color: #64748b;">It may take 5-7 working days for the amount to show in your bank account statement.</p>
</div>`;
    },
  },
];
