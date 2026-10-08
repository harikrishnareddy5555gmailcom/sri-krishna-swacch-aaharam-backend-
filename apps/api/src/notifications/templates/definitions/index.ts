import { type NotificationTemplateDefinition } from '../notification-template.interface.js';
import { AUTH_TEMPLATES } from './auth.templates.js';
import { ORDER_TEMPLATES } from './order.templates.js';
import { PAYMENT_TEMPLATES } from './payment.templates.js';
import { SHIPMENT_TEMPLATES } from './shipment.templates.js';
import { RETURN_REFUND_TEMPLATES } from './return-refund.templates.js';
import { INVOICE_TEMPLATES } from './invoice.templates.js';
import { OPERATIONAL_TEMPLATES } from './operational.templates.js';

export {
  AUTH_TEMPLATES,
  ORDER_TEMPLATES,
  PAYMENT_TEMPLATES,
  SHIPMENT_TEMPLATES,
  RETURN_REFUND_TEMPLATES,
  INVOICE_TEMPLATES,
  OPERATIONAL_TEMPLATES,
};

export const INITIAL_NOTIFICATION_TEMPLATES: NotificationTemplateDefinition[] = [
  ...AUTH_TEMPLATES,
  ...ORDER_TEMPLATES,
  ...PAYMENT_TEMPLATES,
  ...SHIPMENT_TEMPLATES,
  ...RETURN_REFUND_TEMPLATES,
  ...INVOICE_TEMPLATES,
  ...OPERATIONAL_TEMPLATES,
];

export const BUILTIN_TEMPLATES = INITIAL_NOTIFICATION_TEMPLATES;
