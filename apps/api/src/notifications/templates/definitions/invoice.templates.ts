import { NotificationChannel, NotificationEventType } from '@vishkaraa/types';
import {
  type NotificationTemplateDefinition,
  type InvoiceIssuedContext,
} from '../notification-template.interface.js';
import { escapeHtml, sanitizeActionUrl } from '../notification-template.security.js';

export const INVOICE_TEMPLATES: NotificationTemplateDefinition[] = [
  // ─── INVOICE_ISSUED: IN_APP ───────────────────────────────────────────────
  {
    templateKey: NotificationEventType.INVOICE_ISSUED,
    channel: NotificationChannel.IN_APP,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as InvoiceIssuedContext;
      return `Tax Invoice Issued: #${ctx.invoiceNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as InvoiceIssuedContext;
      return `Tax Invoice #${ctx.invoiceNumber} for order #${ctx.orderNumber} (₹${ctx.totalAmount}) is now available for download.`;
    },
  },
  // ─── INVOICE_ISSUED: EMAIL ────────────────────────────────────────────────
  {
    templateKey: NotificationEventType.INVOICE_ISSUED,
    channel: NotificationChannel.EMAIL,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as InvoiceIssuedContext;
      return `Tax Invoice — #${ctx.invoiceNumber} (Order #${ctx.orderNumber})`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as InvoiceIssuedContext;
      return `Hello ${ctx.customerName || 'Customer'},\n\nYour tax invoice #${ctx.invoiceNumber} for order #${ctx.orderNumber} (Total: ₹${ctx.totalAmount}) has been generated.\n\nYou can view and download your invoice from your Vishkaraa account.\n\nWarm regards,\nThe Vishkaraa Naturals Team`;
    },
    renderHtml: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as InvoiceIssuedContext;
      const name = escapeHtml(ctx.customerName || 'Customer');
      const invNo = escapeHtml(ctx.invoiceNumber);
      const orderNo = escapeHtml(ctx.orderNumber);
      const amount = escapeHtml(ctx.totalAmount);
      const invoiceUrl = sanitizeActionUrl(ctx.invoiceUrl, 'https://vishkaraanaturals.com') ?? `https://vishkaraanaturals.com/invoices/${invNo}`;
      return `<div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #15803d;">Tax Invoice Issued</h2>
  <p>Hello <strong>${name}</strong>,</p>
  <p>The tax invoice for your order <strong>#${orderNo}</strong> is ready.</p>
  <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
    <p style="margin: 0 0 8px 0;"><strong>Invoice Number:</strong> #${invNo}</p>
    <p style="margin: 0 0 8px 0;"><strong>Order Number:</strong> #${orderNo}</p>
    <p style="margin: 0;"><strong>Total Invoice Amount:</strong> ₹${amount}</p>
  </div>
  <p style="margin: 24px 0;">
    <a href="${invoiceUrl}" style="background-color: #15803d; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold;">View / Download Invoice</a>
  </p>
  <p style="font-size: 13px; color: #64748b;">This is a system-generated GST compliant invoice document.</p>
</div>`;
    },
  },
];
