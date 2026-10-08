import { NotificationChannel, NotificationEventType } from '@vishkaraa/types';
import {
  type NotificationTemplateDefinition,
  type AuthWelcomeContext,
  type AuthPasswordResetContext,
} from '../notification-template.interface.js';
import { escapeHtml, sanitizeActionUrl } from '../notification-template.security.js';

export const AUTH_TEMPLATES: NotificationTemplateDefinition[] = [
  // ─── AUTH_WELCOME: IN_APP ─────────────────────────────────────────────────
  {
    templateKey: NotificationEventType.AUTH_WELCOME,
    channel: NotificationChannel.IN_APP,
    version: 'v1',
    renderSubject: () => 'Welcome to Vishkaraa Naturals',
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as AuthWelcomeContext;
      return `Welcome to Vishkaraa Naturals, ${ctx.firstName || 'valued customer'}! Discover our range of natural Ayurvedic wellness products.`;
    },
  },
  // ─── AUTH_WELCOME: EMAIL ──────────────────────────────────────────────────
  {
    templateKey: NotificationEventType.AUTH_WELCOME,
    channel: NotificationChannel.EMAIL,
    version: 'v1',
    renderSubject: () => 'Welcome to Vishkaraa Naturals',
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as AuthWelcomeContext;
      return `Hello ${ctx.firstName || 'there'},\n\nWelcome to Vishkaraa Naturals! Your account has been created successfully.\n\nExplore our pure and natural wellness remedies.\n\nWarm regards,\nThe Vishkaraa Naturals Team`;
    },
    renderHtml: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as AuthWelcomeContext;
      const name = escapeHtml(ctx.firstName || 'there');
      return `<div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #15803d;">Welcome to Vishkaraa Naturals</h2>
  <p>Hello <strong>${name}</strong>,</p>
  <p>Thank you for joining Vishkaraa Naturals. Your account is ready.</p>
  <p>Discover our artisanal herbal blends and pure Ayurvedic wellness care.</p>
  <p style="margin-top: 24px; color: #64748b; font-size: 14px;">The Vishkaraa Naturals Team</p>
</div>`;
    },
  },
  // ─── AUTH_PASSWORD_RESET: EMAIL ───────────────────────────────────────────
  {
    templateKey: NotificationEventType.AUTH_PASSWORD_RESET,
    channel: NotificationChannel.EMAIL,
    version: 'v1',
    renderSubject: () => 'Password Reset Request — Vishkaraa Naturals',
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as AuthPasswordResetContext;
      return `Hello ${ctx.firstName || 'there'},\n\nWe received a request to reset your password. Use the link below to set a new password:\n${ctx.resetUrl}\n\nThis link is valid for ${ctx.expiresMinutes || 15} minutes. If you did not request this, you can safely ignore this email.\n\nWarm regards,\nThe Vishkaraa Naturals Team`;
    },
    renderHtml: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as AuthPasswordResetContext;
      const name = escapeHtml(ctx.firstName || 'there');
      const safeUrl = sanitizeActionUrl(ctx.resetUrl, 'https://vishkaraanaturals.com') ?? escapeHtml(ctx.resetUrl);
      const expiry = escapeHtml(ctx.expiresMinutes || 15);
      return `<div style="font-family: sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #b91c1c;">Reset Your Password</h2>
  <p>Hello <strong>${name}</strong>,</p>
  <p>We received a request to reset the password for your Vishkaraa Naturals account.</p>
  <p style="margin: 24px 0;">
    <a href="${safeUrl}" style="background-color: #15803d; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold;">Reset Password</a>
  </p>
  <p style="font-size: 13px; color: #64748b;">This link will expire in ${expiry} minutes. If you did not make this request, please disregard this message.</p>
</div>`;
    },
  },
];
