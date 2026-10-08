import { NotificationChannel, NotificationEventType } from '@vishkaraa/types';
import {
  type NotificationTemplateDefinition,
  type ShipmentDispatchedContext,
  type ShipmentOutForDeliveryContext,
  type ShipmentDeliveredContext,
  type ShipmentFailedContext,
} from '../notification-template.interface.js';
import { escapeHtml, sanitizeActionUrl } from '../notification-template.security.js';

export const SHIPMENT_TEMPLATES: NotificationTemplateDefinition[] = [
  // ─── SHIPMENT_DISPATCHED: IN_APP ──────────────────────────────────────────
  {
    templateKey: NotificationEventType.SHIPMENT_DISPATCHED,
    channel: NotificationChannel.IN_APP,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentDispatchedContext;
      return `Shipment Dispatched: #${ctx.shipmentNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentDispatchedContext;
      return `Your shipment #${ctx.shipmentNumber} for order #${ctx.orderNumber} has been dispatched via ${ctx.carrierName}.${ctx.trackingNumber ? ` Tracking: ${ctx.trackingNumber}` : ''}`;
    },
  },
  // ─── SHIPMENT_DISPATCHED: EMAIL ───────────────────────────────────────────
  {
    templateKey: NotificationEventType.SHIPMENT_DISPATCHED,
    channel: NotificationChannel.EMAIL,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentDispatchedContext;
      return `Your Order has been Dispatched — #${ctx.orderNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentDispatchedContext;
      return `Hello ${ctx.customerName || 'Customer'},\n\nGreat news! Your shipment #${ctx.shipmentNumber} (Order #${ctx.orderNumber}) has been dispatched via ${ctx.carrierName}.\n\nTracking Number: ${ctx.trackingNumber || 'Available shortly'}\n\nWarm regards,\nThe Sri Krishna Swacch Aaharam Team`;
    },
    renderHtml: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentDispatchedContext;
      const name = escapeHtml(ctx.customerName || 'Customer');
      const orderNo = escapeHtml(ctx.orderNumber);
      const shpNo = escapeHtml(ctx.shipmentNumber);
      const carrier = escapeHtml(ctx.carrierName);
      const tracking = escapeHtml(ctx.trackingNumber || 'Available shortly');
      const trackUrl = sanitizeActionUrl(ctx.trackingUrl, 'https://vishkaraanaturals.com') ?? `https://vishkaraanaturals.com/orders/${orderNo}`;
      return `<div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #15803d;">Your Order is On Its Way!</h2>
  <p>Hello <strong>${name}</strong>,</p>
  <p>Your items have been carefully packed and handed over to our courier partner.</p>
  <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
    <p style="margin: 0 0 8px 0;"><strong>Order Number:</strong> #${orderNo}</p>
    <p style="margin: 0 0 8px 0;"><strong>Shipment Number:</strong> #${shpNo}</p>
    <p style="margin: 0 0 8px 0;"><strong>Carrier:</strong> ${carrier}</p>
    <p style="margin: 0;"><strong>Tracking Number:</strong> ${tracking}</p>
  </div>
  <p style="margin: 24px 0;">
    <a href="${trackUrl}" style="background-color: #15803d; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold;">Track Shipment</a>
  </p>
</div>`;
    },
  },
  // ─── SHIPMENT_DISPATCHED: SMS ─────────────────────────────────────────────
  {
    templateKey: NotificationEventType.SHIPMENT_DISPATCHED,
    channel: NotificationChannel.SMS,
    version: 'v1',
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentDispatchedContext;
      return `Sri Krishna Swacch Aaharam: Shipment #${ctx.shipmentNumber} for order #${ctx.orderNumber} dispatched via ${ctx.carrierName}. Tracking: ${ctx.trackingNumber || 'N/A'}.`;
    },
  },

  // ─── SHIPMENT_OUT_FOR_DELIVERY: IN_APP ────────────────────────────────────
  {
    templateKey: NotificationEventType.SHIPMENT_OUT_FOR_DELIVERY,
    channel: NotificationChannel.IN_APP,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentOutForDeliveryContext;
      return `Out for Delivery: #${ctx.shipmentNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentOutForDeliveryContext;
      return `Your shipment #${ctx.shipmentNumber} is out for delivery today. Please keep your phone reachable.`;
    },
  },
  // ─── SHIPMENT_OUT_FOR_DELIVERY: SMS ───────────────────────────────────────
  {
    templateKey: NotificationEventType.SHIPMENT_OUT_FOR_DELIVERY,
    channel: NotificationChannel.SMS,
    version: 'v1',
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentOutForDeliveryContext;
      return `Sri Krishna Swacch Aaharam: Shipment #${ctx.shipmentNumber} for order #${ctx.orderNumber} is out for delivery today. Please keep your phone reachable.`;
    },
  },

  // ─── SHIPMENT_DELIVERED: IN_APP ───────────────────────────────────────────
  {
    templateKey: NotificationEventType.SHIPMENT_DELIVERED,
    channel: NotificationChannel.IN_APP,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentDeliveredContext;
      return `Shipment Delivered: #${ctx.shipmentNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentDeliveredContext;
      return `Your shipment #${ctx.shipmentNumber} for order #${ctx.orderNumber} has been delivered. We hope you enjoy your products!`;
    },
  },
  // ─── SHIPMENT_DELIVERED: EMAIL ────────────────────────────────────────────
  {
    templateKey: NotificationEventType.SHIPMENT_DELIVERED,
    channel: NotificationChannel.EMAIL,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentDeliveredContext;
      return `Your Order has been Delivered — #${ctx.orderNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentDeliveredContext;
      return `Hello ${ctx.customerName || 'Customer'},\n\nYour shipment #${ctx.shipmentNumber} (Order #${ctx.orderNumber}) was successfully delivered!\n\nWe hope you enjoy your products.\n\nWarm regards,\nThe Sri Krishna Swacch Aaharam Team`;
    },
    renderHtml: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentDeliveredContext;
      const name = escapeHtml(ctx.customerName || 'Customer');
      const orderNo = escapeHtml(ctx.orderNumber);
      const shpNo = escapeHtml(ctx.shipmentNumber);
      return `<div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #15803d;">Delivered with Care!</h2>
  <p>Hello <strong>${name}</strong>,</p>
  <p>Your package <strong>#${shpNo}</strong> for order <strong>#${orderNo}</strong> has been successfully delivered.</p>
  <p>Thank you for choosing Sri Krishna Swacch Aaharam. If you have any feedback or concerns, our team is always here to assist.</p>
</div>`;
    },
  },
  // ─── SHIPMENT_DELIVERED: SMS ──────────────────────────────────────────────
  {
    templateKey: NotificationEventType.SHIPMENT_DELIVERED,
    channel: NotificationChannel.SMS,
    version: 'v1',
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentDeliveredContext;
      return `Sri Krishna Swacch Aaharam: Shipment #${ctx.shipmentNumber} for order #${ctx.orderNumber} has been delivered. Thank you for choosing Sri Krishna Swacch Aaharam!`;
    },
  },

  // ─── SHIPMENT_FAILED: IN_APP ──────────────────────────────────────────────
  {
    templateKey: NotificationEventType.SHIPMENT_FAILED,
    channel: NotificationChannel.IN_APP,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentFailedContext;
      return `Delivery Attempt Failed: #${ctx.shipmentNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentFailedContext;
      return `Delivery attempt for shipment #${ctx.shipmentNumber} was unsuccessful.${ctx.reason ? ` Reason: ${ctx.reason}` : ''}`;
    },
  },
  // ─── SHIPMENT_FAILED: EMAIL ───────────────────────────────────────────────
  {
    templateKey: NotificationEventType.SHIPMENT_FAILED,
    channel: NotificationChannel.EMAIL,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentFailedContext;
      return `Delivery Attempt Unsuccessful — #${ctx.orderNumber}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentFailedContext;
      return `Hello ${ctx.customerName || 'Customer'},\n\nA delivery attempt for shipment #${ctx.shipmentNumber} (Order #${ctx.orderNumber}) could not be completed.${ctx.reason ? ` Reason: ${ctx.reason}` : ''}\n\nOur courier partner will re-attempt delivery shortly.\n\nWarm regards,\nThe Sri Krishna Swacch Aaharam Team`;
    },
    renderHtml: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentFailedContext;
      const name = escapeHtml(ctx.customerName || 'Customer');
      const orderNo = escapeHtml(ctx.orderNumber);
      const shpNo = escapeHtml(ctx.shipmentNumber);
      const reason = escapeHtml(ctx.reason || 'Customer address unreachable or contact unavailable');
      return `<div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #b91c1c;">Delivery Attempt Unsuccessful</h2>
  <p>Hello <strong>${name}</strong>,</p>
  <p>Our courier partner attempted to deliver your shipment <strong>#${shpNo}</strong> (Order #${orderNo}), but was unable to complete the delivery.</p>
  <p style="color: #64748b; font-size: 14px;"><strong>Reason:</strong> ${reason}</p>
  <p>A second delivery attempt will be made. Please ensure your contact number is reachable.</p>
</div>`;
    },
  },
  // ─── SHIPMENT_FAILED: SMS ─────────────────────────────────────────────────
  {
    templateKey: NotificationEventType.SHIPMENT_FAILED,
    channel: NotificationChannel.SMS,
    version: 'v1',
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ShipmentFailedContext;
      return `Sri Krishna Swacch Aaharam: Delivery attempt for shipment #${ctx.shipmentNumber} was unsuccessful. A re-attempt will be scheduled shortly.`;
    },
  },
];
