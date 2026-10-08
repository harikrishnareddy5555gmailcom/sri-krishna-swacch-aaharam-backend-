/**
 * Notification Domain Constants — Phase 14B
 *
 * Encodes the approved event-to-channel preference matrix and category semantics.
 */

import {
  NotificationCategory,
  NotificationChannel,
  NotificationEventType,
  type NotificationEventTypeString,
} from '@vishkaraa/types';

export interface ChannelRule {
  readonly isSupported: boolean;
  readonly isMandatory: boolean; // If true, customer cannot disable via preferences
  readonly defaultEnabled: boolean;
}

export type EventChannelMatrix = Record<
  NotificationEventTypeString,
  Record<NotificationChannel, ChannelRule>
>;

/**
 * Approved Phase 14 Event & Channel Preference Matrix
 *
 * Distinguishes mandatory channels (e.g. IN_APP / EMAIL for critical order events)
 * from optional channels (e.g. SMS) that customers can toggle.
 */
export const EVENT_CHANNEL_PREFERENCE_MATRIX: EventChannelMatrix = {
  [NotificationEventType.AUTH_WELCOME]: {
    [NotificationChannel.IN_APP]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.EMAIL]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.SMS]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.WHATSAPP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.PUSH]: { isSupported: false, isMandatory: false, defaultEnabled: false },
  },
  [NotificationEventType.AUTH_PASSWORD_RESET]: {
    [NotificationChannel.IN_APP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.EMAIL]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.SMS]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.WHATSAPP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.PUSH]: { isSupported: false, isMandatory: false, defaultEnabled: false },
  },
  [NotificationEventType.ORDER_CONFIRMED]: {
    [NotificationChannel.IN_APP]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.EMAIL]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.SMS]: { isSupported: true, isMandatory: false, defaultEnabled: true },
    [NotificationChannel.WHATSAPP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.PUSH]: { isSupported: false, isMandatory: false, defaultEnabled: false },
  },
  [NotificationEventType.ORDER_CANCELLED]: {
    [NotificationChannel.IN_APP]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.EMAIL]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.SMS]: { isSupported: true, isMandatory: false, defaultEnabled: true },
    [NotificationChannel.WHATSAPP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.PUSH]: { isSupported: false, isMandatory: false, defaultEnabled: false },
  },
  [NotificationEventType.PAYMENT_CAPTURED]: {
    [NotificationChannel.IN_APP]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.EMAIL]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.SMS]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.WHATSAPP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.PUSH]: { isSupported: false, isMandatory: false, defaultEnabled: false },
  },
  [NotificationEventType.PAYMENT_FAILED]: {
    [NotificationChannel.IN_APP]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.EMAIL]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.SMS]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.WHATSAPP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.PUSH]: { isSupported: false, isMandatory: false, defaultEnabled: false },
  },
  [NotificationEventType.SHIPMENT_DISPATCHED]: {
    [NotificationChannel.IN_APP]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.EMAIL]: { isSupported: true, isMandatory: false, defaultEnabled: true },
    [NotificationChannel.SMS]: { isSupported: true, isMandatory: false, defaultEnabled: true },
    [NotificationChannel.WHATSAPP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.PUSH]: { isSupported: false, isMandatory: false, defaultEnabled: false },
  },
  [NotificationEventType.SHIPMENT_OUT_FOR_DELIVERY]: {
    [NotificationChannel.IN_APP]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.EMAIL]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.SMS]: { isSupported: true, isMandatory: false, defaultEnabled: true },
    [NotificationChannel.WHATSAPP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.PUSH]: { isSupported: false, isMandatory: false, defaultEnabled: false },
  },
  [NotificationEventType.SHIPMENT_DELIVERED]: {
    [NotificationChannel.IN_APP]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.EMAIL]: { isSupported: true, isMandatory: false, defaultEnabled: true },
    [NotificationChannel.SMS]: { isSupported: true, isMandatory: false, defaultEnabled: true },
    [NotificationChannel.WHATSAPP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.PUSH]: { isSupported: false, isMandatory: false, defaultEnabled: false },
  },
  [NotificationEventType.SHIPMENT_FAILED]: {
    [NotificationChannel.IN_APP]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.EMAIL]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.SMS]: { isSupported: true, isMandatory: false, defaultEnabled: true },
    [NotificationChannel.WHATSAPP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.PUSH]: { isSupported: false, isMandatory: false, defaultEnabled: false },
  },
  [NotificationEventType.RETURN_APPROVED]: {
    [NotificationChannel.IN_APP]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.EMAIL]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.SMS]: { isSupported: true, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.WHATSAPP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.PUSH]: { isSupported: false, isMandatory: false, defaultEnabled: false },
  },
  [NotificationEventType.REFUND_COMPLETED]: {
    [NotificationChannel.IN_APP]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.EMAIL]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.SMS]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.WHATSAPP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.PUSH]: { isSupported: false, isMandatory: false, defaultEnabled: false },
  },
  [NotificationEventType.INVOICE_ISSUED]: {
    [NotificationChannel.IN_APP]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.EMAIL]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.SMS]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.WHATSAPP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.PUSH]: { isSupported: false, isMandatory: false, defaultEnabled: false },
  },
  [NotificationEventType.RECONCILIATION_REQUIRED]: {
    [NotificationChannel.IN_APP]: { isSupported: true, isMandatory: true, defaultEnabled: true },
    [NotificationChannel.EMAIL]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.SMS]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.WHATSAPP]: { isSupported: false, isMandatory: false, defaultEnabled: false },
    [NotificationChannel.PUSH]: { isSupported: false, isMandatory: false, defaultEnabled: false },
  },
};

/**
 * Event classification by category.
 */
export function getCategoryForEventType(eventType: NotificationEventTypeString): NotificationCategory {
  if (eventType === NotificationEventType.RECONCILIATION_REQUIRED) {
    return NotificationCategory.OPERATIONAL;
  }
  return NotificationCategory.TRANSACTIONAL;
}

/**
 * Checks whether a channel is mandatory for an event type (user cannot opt-out).
 */
export function isChannelMandatory(
  eventType: NotificationEventTypeString,
  channel: NotificationChannel,
): boolean {
  const rule = EVENT_CHANNEL_PREFERENCE_MATRIX[eventType]?.[channel];
  return rule?.isMandatory ?? false;
}
