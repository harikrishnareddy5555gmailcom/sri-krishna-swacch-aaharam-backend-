/**
 * Shipping & Fulfillment Domain Constants — Phase 13
 */

export const SHIPPING_NUMBER_PREFIX = 'SHP';

/**
 * Injection token for pluggable shipping courier provider adapters.
 */
export const SHIPPING_PROVIDER = Symbol('SHIPPING_PROVIDER');

/**
 * Carrier codes recognized across the platform.
 */
export const CarrierCodes = {
  SHIPROCKET: 'SHIPROCKET',
  DELHIVERY: 'DELHIVERY',
  BLUEDART: 'BLUEDART',
  MANUAL: 'MANUAL',
} as const;

export type CarrierCode = (typeof CarrierCodes)[keyof typeof CarrierCodes] | (string & {});
