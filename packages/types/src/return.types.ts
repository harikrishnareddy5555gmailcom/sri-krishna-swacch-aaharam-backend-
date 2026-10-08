/**
 * Return Types
 *
 * Architectural boundary for the Return module.
 * Full implementation is a future phase.
 *
 * Return Lifecycle:
 *
 *   REQUESTED    — User has submitted a return request
 *   UNDER_REVIEW — Admin is reviewing the request
 *   APPROVED     — Return approved, awaiting item receipt
 *   REJECTED     — Return rejected by admin
 *   RECEIVED     — Returned item received by warehouse
 *   COMPLETED    — Return fully processed
 *   CANCELLED    — Return cancelled (by user or admin)
 */

export enum ReturnStatus {
  REQUESTED = 'REQUESTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RECEIVED = 'RECEIVED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum ReturnReason {
  DAMAGED_PRODUCT = 'DAMAGED_PRODUCT',
  WRONG_PRODUCT = 'WRONG_PRODUCT',
  NOT_AS_DESCRIBED = 'NOT_AS_DESCRIBED',
  DEFECTIVE = 'DEFECTIVE',
  CHANGED_MIND = 'CHANGED_MIND',
  OTHER = 'OTHER',
}

/** Core return entity */
export interface Return {
  id: string;
  orderId: string;
  userId: string;
  reason: ReturnReason;
  description?: string;
  status: ReturnStatus;
  requestedAt: Date;
  reviewedAt?: Date;
  reviewedBy?: string; // Admin user ID
  decision?: string;
  relatedRefundId?: string;
  createdAt: Date;
  updatedAt: Date;
}
