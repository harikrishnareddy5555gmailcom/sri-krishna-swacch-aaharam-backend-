import { CURRENCY_SYMBOL, CURRENCY_UNIT_MULTIPLIER } from './constants.js';

/**
 * Shared utility/helper functions.
 * These are pure functions with no side effects.
 */

/**
 * Format an amount (in smallest unit, e.g., paise) to a display string.
 * Example: 100000 → "₹1,000.00"
 */
export function formatCurrency(
  amountInSmallestUnit: number,
  currency = 'INR',
  locale = 'en-IN',
): string {
  const amount = amountInSmallestUnit / CURRENCY_UNIT_MULTIPLIER;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format a currency with the simple symbol prefix.
 * Example: 100000 → "₹1,000"
 */
export function formatCurrencySimple(amountInSmallestUnit: number): string {
  const amount = amountInSmallestUnit / CURRENCY_UNIT_MULTIPLIER;
  return `${CURRENCY_SYMBOL}${amount.toLocaleString('en-IN')}`;
}

/**
 * Convert amount from display units (e.g., ₹) to smallest units (paise).
 * Example: 1000 → 100000
 */
export function toSmallestUnit(amount: number): number {
  return Math.round(amount * CURRENCY_UNIT_MULTIPLIER);
}

/**
 * Calculate the remaining refundable amount for an order.
 * Ensures we never exceed the total order amount.
 */
export function calculateRemainingRefundable(totalAmount: number, refundedAmount: number): number {
  return Math.max(0, totalAmount - refundedAmount);
}

/**
 * Format a date for display.
 */
export function formatDate(date: Date | string, locale = 'en-IN'): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(date));
}

/**
 * Format a date with time for display.
 */
export function formatDateTime(date: Date | string, locale = 'en-IN'): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

/**
 * Generate a human-readable order reference number.
 * In production, use the actual order ID from the database.
 */
export function formatOrderRef(orderId: string): string {
  return `#${orderId.slice(0, 8).toUpperCase()}`;
}

/**
 * Truncate a string to a maximum length with ellipsis.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength - 3)}...`;
}

/**
 * Calculate the discount amount in the smallest currency unit (e.g. paise):
 * Discount amount = MRP − Selling price
 *
 * Guarantees:
 * - Returns 0 if MRP is null, undefined, or <= 0
 * - Returns 0 if selling price is null, undefined, or <= 0
 * - Returns 0 if selling price >= MRP
 */
export function calculateDiscountAmount(
  mrpInPaise?: number | null,
  sellingPriceInPaise?: number | null,
): number {
  if (!mrpInPaise || !sellingPriceInPaise) return 0;
  if (mrpInPaise <= 0 || sellingPriceInPaise <= 0) return 0;
  if (sellingPriceInPaise >= mrpInPaise) return 0;
  return mrpInPaise - sellingPriceInPaise;
}

/**
 * Calculate the discount percentage:
 * Discount percentage = ((MRP − Selling price) / MRP) × 100
 *
 * Validation & edge cases:
 * - MRP ₹500, selling price ₹400 → 20% discount
 * - MRP ₹1,000, selling price ₹850 → 15% discount
 * - MRP ₹500, selling price ₹500 → 0% discount
 * - Selling price > MRP → 0% discount
 * - MRP <= 0 → 0% discount (division by zero prevented)
 * - Returns rounded integer percentage (0 to 100)
 */
export function calculateDiscountPercentage(
  mrpInPaise?: number | null,
  sellingPriceInPaise?: number | null,
): number {
  if (!mrpInPaise || !sellingPriceInPaise) return 0;
  if (mrpInPaise <= 0 || sellingPriceInPaise <= 0) return 0;
  if (sellingPriceInPaise >= mrpInPaise) return 0;
  const percentage = ((mrpInPaise - sellingPriceInPaise) / mrpInPaise) * 100;
  return Math.round(percentage);
}

