import { NotificationChannel, NotificationEventType } from '@vishkaraa/types';
import {
  type NotificationTemplateDefinition,
  type ReconciliationRequiredContext,
} from '../notification-template.interface.js';

export const OPERATIONAL_TEMPLATES: NotificationTemplateDefinition[] = [
  // ─── RECONCILIATION_REQUIRED: IN_APP ──────────────────────────────────────
  {
    templateKey: NotificationEventType.RECONCILIATION_REQUIRED,
    channel: NotificationChannel.IN_APP,
    version: 'v1',
    renderSubject: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ReconciliationRequiredContext;
      return `[OPERATIONAL ALERT] Reconciliation Required: ${ctx.entityType} ${ctx.entityId}`;
    },
    renderText: (rawCtx: Record<string, unknown>) => {
      const ctx = rawCtx as unknown as ReconciliationRequiredContext;
      return `Operational discrepancy detected on ${ctx.entityType} (${ctx.entityId}): ${ctx.discrepancyDetails}.${ctx.detectedAt ? ` Detected at: ${ctx.detectedAt}` : ''} Manual review required by admin.`;
    },
  },
];
