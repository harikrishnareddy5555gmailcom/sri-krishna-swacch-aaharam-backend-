import { PaymentStatus } from '@vishkaraa/types';

/**
 * Result of evaluating a payment state transition.
 *
 * - APPLIED: Valid progressive state change; database record should be updated.
 * - NO_OP_DUPLICATE: Duplicate event for the same status (safe idempotent no-op).
 * - NO_OP_STALE_EVENT: Delayed/out-of-order event for an earlier phase received
 *   after payment has already advanced (e.g. delayed AUTHORIZED arriving after CAPTURED,
 *   or delayed FAILED/CANCELLED arriving after CAPTURED). Payment must NEVER regress.
 * - INVALID_TRANSITION: Genuine illegal transition (e.g. FAILED -> CAPTURED,
 *   CANCELLED -> CAPTURED, CREATED -> CAPTURED). Must be rejected.
 * - REQUIRES_RECONCILIATION: Provider reports CAPTURED but local state is FAILED or
 *   CANCELLED. Money captured while local record conflicts. Needs admin resolution.
 */
export enum TransitionEvaluationResult {
  APPLIED = 'APPLIED',
  NO_OP_DUPLICATE = 'NO_OP_DUPLICATE',
  NO_OP_STALE_EVENT = 'NO_OP_STALE_EVENT',
  INVALID_TRANSITION = 'INVALID_TRANSITION',
  REQUIRES_RECONCILIATION = 'REQUIRES_RECONCILIATION',
}

/**
 * Explicit progressive transitions allowed:
 *
 * CREATED -> PENDING, CANCELLED
 * PENDING -> AUTHORIZED, CAPTURED, FAILED, CANCELLED
 * AUTHORIZED -> CAPTURED, FAILED, CANCELLED
 * CAPTURED -> terminal (authoritative final success)
 * FAILED -> terminal (but provider-reported CAPTURED becomes REQUIRES_RECONCILIATION)
 * CANCELLED -> terminal (but provider-reported CAPTURED becomes REQUIRES_RECONCILIATION)
 * REQUIRES_RECONCILIATION -> terminal (admin must resolve)
 */
const FORWARD_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  [PaymentStatus.CREATED]: [PaymentStatus.PENDING, PaymentStatus.CANCELLED],
  [PaymentStatus.PENDING]: [
    PaymentStatus.AUTHORIZED,
    PaymentStatus.CAPTURED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ],
  [PaymentStatus.AUTHORIZED]: [
    PaymentStatus.CAPTURED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ],
  [PaymentStatus.CAPTURED]: [],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.CANCELLED]: [],
  [PaymentStatus.REQUIRES_RECONCILIATION]: [],
};

/**
 * Known earlier/stale states that may arrive out of order when a payment
 * is already in a more advanced state:
 *
 * Once CAPTURED:
 * - Duplicate CAPTURED is NO_OP_DUPLICATE.
 * - Delayed AUTHORIZED, PENDING, CREATED are NO_OP_STALE_EVENT.
 * - Delayed FAILED, CANCELLED arriving after CAPTURED are NO_OP_STALE_EVENT
 *   (CAPTURED money is authoritative; webhook race or late failure must not regress captured funds).
 *
 * Once AUTHORIZED:
 * - Duplicate AUTHORIZED is NO_OP_DUPLICATE.
 * - Delayed PENDING, CREATED are NO_OP_STALE_EVENT.
 *
 * Once REQUIRES_RECONCILIATION:
 * - Duplicate CAPTURED or RECONCILIATION events are NO_OP_DUPLICATE (already captured by admin).
 * - Any other events are stale.
 */
const TOLERATED_STALE_EVENTS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  [PaymentStatus.CAPTURED]: [
    PaymentStatus.CREATED,
    PaymentStatus.PENDING,
    PaymentStatus.AUTHORIZED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ],
  [PaymentStatus.AUTHORIZED]: [PaymentStatus.CREATED, PaymentStatus.PENDING],
  [PaymentStatus.PENDING]: [PaymentStatus.CREATED],
  [PaymentStatus.CREATED]: [],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.CANCELLED]: [],
  [PaymentStatus.REQUIRES_RECONCILIATION]: [
    PaymentStatus.CREATED,
    PaymentStatus.PENDING,
    PaymentStatus.AUTHORIZED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ],
};

/**
 * States that require reconciliation when provider reports CAPTURED.
 *
 * These are terminal failure states — we know locally the payment failed,
 * but the provider says it captured money. This must surface explicitly.
 */
const RECONCILIATION_STATES = new Set<PaymentStatus>([
  PaymentStatus.FAILED,
  PaymentStatus.CANCELLED,
]);

export class PaymentStateMachine {
  /**
   * Evaluates the outcome of attempting to transition from currentStatus to nextStatus.
   * Deterministic, provider-independent, and webhook-safe.
   *
   * Special case: FAILED/CANCELLED + provider CAPTURED = REQUIRES_RECONCILIATION.
   * This is NOT a normal forward transition or a stale event — it means money was
   * captured by the provider while local state recorded a failure. Must surface visibly.
   */
  static evaluateTransition(
    currentStatus: PaymentStatus,
    nextStatus: PaymentStatus,
  ): TransitionEvaluationResult {
    // 0. Already in REQUIRES_RECONCILIATION — idempotent no-op for duplicates
    if (currentStatus === PaymentStatus.REQUIRES_RECONCILIATION) {
      if (nextStatus === PaymentStatus.REQUIRES_RECONCILIATION) {
        return TransitionEvaluationResult.NO_OP_DUPLICATE;
      }
      const toleratedStale = TOLERATED_STALE_EVENTS[PaymentStatus.REQUIRES_RECONCILIATION];
      if (toleratedStale && toleratedStale.includes(nextStatus)) {
        return TransitionEvaluationResult.NO_OP_STALE_EVENT;
      }
      return TransitionEvaluationResult.INVALID_TRANSITION;
    }

    // 1. Identical state = safe idempotent duplicate no-op
    if (currentStatus === nextStatus) {
      return TransitionEvaluationResult.NO_OP_DUPLICATE;
    }

    // 2. RECONCILIATION: local state is FAILED/CANCELLED but provider says CAPTURED.
    //    This is NOT a stale event — money is at risk. Escalate explicitly.
    if (
      RECONCILIATION_STATES.has(currentStatus) &&
      nextStatus === PaymentStatus.CAPTURED
    ) {
      return TransitionEvaluationResult.REQUIRES_RECONCILIATION;
    }

    // 3. Progressive forward transition = APPLIED
    const allowedForward = FORWARD_TRANSITIONS[currentStatus];
    if (allowedForward && allowedForward.includes(nextStatus)) {
      return TransitionEvaluationResult.APPLIED;
    }

    // 4. Stale / delayed out-of-order event = safe no-op (never move payment backwards)
    const toleratedStale = TOLERATED_STALE_EVENTS[currentStatus];
    if (toleratedStale && toleratedStale.includes(nextStatus)) {
      return TransitionEvaluationResult.NO_OP_STALE_EVENT;
    }

    // 5. Genuine illegal transition
    return TransitionEvaluationResult.INVALID_TRANSITION;
  }

  /**
   * Checks if a transition can be applied as a new state update.
   */
  static canTransition(
    currentStatus: PaymentStatus,
    nextStatus: PaymentStatus,
  ): boolean {
    const result = this.evaluateTransition(currentStatus, nextStatus);
    return (
      result === TransitionEvaluationResult.APPLIED ||
      result === TransitionEvaluationResult.NO_OP_DUPLICATE
    );
  }

  /**
   * Asserts that a state transition is valid, throwing an Error on genuine illegal transitions.
   * Returns the evaluation result so caller can distinguish APPLIED vs NO_OP.
   */
  static assertValidTransition(
    currentStatus: PaymentStatus,
    nextStatus: PaymentStatus,
  ): TransitionEvaluationResult {
    const result = this.evaluateTransition(currentStatus, nextStatus);
    if (
      result === TransitionEvaluationResult.INVALID_TRANSITION ||
      result === TransitionEvaluationResult.REQUIRES_RECONCILIATION
    ) {
      throw new Error(
        `Invalid payment status transition: cannot transition from ${currentStatus} to ${nextStatus}`,
      );
    }
    return result;
  }

  /**
   * Returns whether a payment status is a terminal state
   * (no further provider-driven transitions expected).
   */
  static isTerminal(status: PaymentStatus): boolean {
    return (
      status === PaymentStatus.CAPTURED ||
      status === PaymentStatus.FAILED ||
      status === PaymentStatus.CANCELLED ||
      status === PaymentStatus.REQUIRES_RECONCILIATION
    );
  }
}
