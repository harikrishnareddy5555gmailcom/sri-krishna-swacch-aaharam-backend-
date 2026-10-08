/**
 * Refund Types
 *
 * Architectural boundary for the Refund module.
 * Full implementation is a future phase.
 *
 * IMPORTANT BUSINESS RULE:
 * - The system must support FULL and PARTIAL refunds.
 * - Total refunded amount must NEVER exceed the eligible refund amount.
 * - Every refund must be auditable.
 *
 * Example:
 *   Order total = ₹5,000
 *   First refund (partial) = ₹1,500  → refundedAmount = ₹1,500
 *   Second refund (partial) = ₹2,000 → refundedAmount = ₹3,500
 *   Max remaining refundable = ₹1,500
 *
 * Refund Lifecycle:
 *
 *   PENDING    — Refund created, awaiting processing
 *   PROCESSING — Refund being processed by payment provider
 *   COMPLETED  — Refund successfully issued to customer
 *   FAILED     — Refund attempt failed
 *   CANCELLED  — Refund cancelled before processing
 */

export enum RefundStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export enum RefundType {
  FULL = 'FULL',
  PARTIAL = 'PARTIAL',
}

/** Core refund entity */
export interface Refund {
  id: string;
  orderId: string;
  userId: string;
  returnId?: string; // If this refund is linked to a return
  type: RefundType;
  amount: number; // Amount in smallest currency unit
  currency: string; // e.g., 'INR'
  status: RefundStatus;
  reason?: string;
  processedBy?: string; // Admin user ID
  processedAt?: Date;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}
