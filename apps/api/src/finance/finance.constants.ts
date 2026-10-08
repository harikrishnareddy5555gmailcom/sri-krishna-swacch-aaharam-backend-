/**
 * Finance Domain Constants — Phase 15A
 *
 * Stable account codes, permission keys, and source type constants
 * used throughout the finance domain.
 */

// ---------------------------------------------------------------------------
// Chart-of-Accounts Codes
// ---------------------------------------------------------------------------
// Referenced by code string, NOT by UUID, so the application is decoupled
// from auto-generated IDs. Must match the seeds in migration.sql.
// ---------------------------------------------------------------------------
export const ACCOUNT_CODES = {
  CASH_AND_BANK:             '1000',
  PAYMENT_GATEWAY_CLEARING:  '1100',
  ACCOUNTS_RECEIVABLE:       '1200',
  ACCOUNTS_PAYABLE:          '2000',
  GST_TAX_PAYABLE:           '2100',
  SALES_REVENUE:             '3000',
  SHIPPING_REVENUE:          '3100',
  DISCOUNTS_RETURNS:         '4000',
  REFUNDS_ISSUED:            '4100',
  OPERATING_EXPENSES:        '5000',
  COST_OF_GOODS_SOLD:        '5100',
} as const;

export type AccountCode = (typeof ACCOUNT_CODES)[keyof typeof ACCOUNT_CODES];

// ---------------------------------------------------------------------------
// Permission Keys
// ---------------------------------------------------------------------------
export const FINANCE_PERMISSIONS = {
  VIEW:   'FINANCE.VIEW',
  POST:   'FINANCE.POST',
  MANAGE: 'FINANCE.MANAGE',
  VOID:   'FINANCE.VOID',
} as const;

// ---------------------------------------------------------------------------
// Source Type Constants
// ---------------------------------------------------------------------------
export const FINANCE_SOURCE_TYPES = {
  ORDER:      'ORDER',
  PAYMENT:    'PAYMENT',
  REFUND:     'REFUND',
  INVOICE:    'INVOICE',
  EXPENSE:    'EXPENSE',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;

export type FinanceSourceType = (typeof FINANCE_SOURCE_TYPES)[keyof typeof FINANCE_SOURCE_TYPES];

// ---------------------------------------------------------------------------
// Idempotency Key Builders
// ---------------------------------------------------------------------------
export const buildIdempotencyKey = {
  sale:       (orderId: string)            => `sale_order_${orderId}`,
  payment:    (paymentAttemptId: string)   => `payment_${paymentAttemptId}`,
  refund:     (refundId: string)           => `refund_${refundId}`,
  invoice:    (invoiceId: string)          => `invoice_${invoiceId}`,
  expense:    (expenseId: string)          => `expense_post_${expenseId}`,
  adjustment: (adjustmentId: string)      => `adjustment_${adjustmentId}`,
} as const;
