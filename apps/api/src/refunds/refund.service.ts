import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service.js';
import {
  RefundStatus,
  RefundAttemptStatus,
  RefundSource,
  RefundType,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import {
  AuditAction,
  AuditEntityType,
  NotificationCategory,
  NotificationEventType,
} from '@vishkaraa/types';
import { AuditService } from '../audit/audit.service.js';
import type { MinimalUser } from '../permissions/permissions.service.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../payment/providers/payment-provider.interface.js';
import { NotificationService } from '../notifications/notification.service.js';
import { FinanceService } from '../finance/finance.service.js';

// =============================================================================
// AUTO-APPROVAL THRESHOLD
// =============================================================================
// Refunds at or below this amount (in paise) bypass the REQUESTED → APPROVED
// step and are dispatched immediately if the actor has REFUNDS.CREATE.
// 200_000 paise = ₹2,000. Configurable via environment variable.
// =============================================================================
const AUTO_APPROVAL_THRESHOLD_PAISE =
  parseInt(process.env['REFUND_AUTO_APPROVAL_THRESHOLD_PAISE'] ?? '200000', 10);

// Maximum number of gateway attempts before permanent FAILED
const MAX_REFUND_ATTEMPTS = 3;

// =============================================================================
// REFUND NUMBER GENERATION
// =============================================================================
function generateRefundNumber(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const fragment = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `RF-${yyyy}${mm}-${fragment}`;
}

// =============================================================================
// DTO TYPES
// =============================================================================

export interface CreateRefundDto {
  /** Refund amount in integer paise. Must be > 0 and <= remaining balance. */
  amount: number;
  /** Mandatory business justification (min 5 chars). */
  reason: string;
  /** Refund trigger source. */
  source: RefundSource;
  /** Optional administrative notes. */
  notes?: string;
  /**
   * Client-supplied idempotency key (UUID v4 recommended).
   * If provided, duplicate requests with same key return existing Refund with 200.
   */
  idempotencyKey?: string;
  /** Optional linked Return ID (Phase 10 RMA integration) */
  returnId?: string;
}

export interface ApproveRefundDto {
  /** Optional adjusted amount (must be <= requested amount). Defaults to full requested amount. */
  approvedAmount?: number;
}

export interface RejectRefundDto {
  /** Mandatory reason for rejection. */
  rejectionReason: string;
}

export interface ReconcileRefundAttemptDto {
  /** Target resolution status for the ambiguous attempt. */
  resolution: 'PROCESSED' | 'FAILED';
  notes?: string;
}

// =============================================================================
// RESPONSE DTO TYPES
// =============================================================================

export interface RefundAttemptDto {
  id: string;
  attemptNumber: number;
  provider: string;
  providerRefundId: string | null;
  amount: number;
  currency: string;
  status: RefundAttemptStatus;
  gatewayErrorCode: string | null;
  gatewayErrorMessage: string | null;
  reconciledAt: Date | null;
  createdAt: Date;
}

export interface RefundDto {
  id: string;
  refundNumber: string;
  orderId: string;
  paymentAttemptId: string;
  source: RefundSource;
  type: RefundType;
  status: RefundStatus;
  amount: number;
  approvedAmount: number | null;
  refundedAmount: number;
  currency: string;
  reason: string;
  notes: string | null;
  requestedById: string;
  approvedById: string | null;
  approvedAt: Date | null;
  rejectedById: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  attempts: RefundAttemptDto[];
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderRefundSummaryDto {
  refunds: RefundDto[];
  capturedAmount: number;
  totalRefundedAmount: number;
  remainingRefundableBalance: number;
  currency: string;
}

// =============================================================================
// PRISMA QUERY SHAPES
// =============================================================================

type RefundWithAttempts = Prisma.RefundGetPayload<{
  include: { attempts: true };
}>;

function mapAttemptToDto(attempt: RefundWithAttempts['attempts'][number]): RefundAttemptDto {
  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    provider: attempt.provider,
    providerRefundId: attempt.providerRefundId,
    amount: attempt.amount,
    currency: attempt.currency,
    status: attempt.status,
    gatewayErrorCode: attempt.gatewayErrorCode,
    gatewayErrorMessage: attempt.gatewayErrorMessage,
    reconciledAt: attempt.reconciledAt,
    createdAt: attempt.createdAt,
  };
}

function mapRefundToDto(refund: RefundWithAttempts): RefundDto {
  return {
    id: refund.id,
    refundNumber: refund.refundNumber,
    orderId: refund.orderId,
    paymentAttemptId: refund.paymentAttemptId,
    source: refund.source,
    type: refund.type,
    status: refund.status,
    amount: refund.amount,
    approvedAmount: refund.approvedAmount,
    refundedAmount: refund.refundedAmount,
    currency: refund.currency,
    reason: refund.reason,
    notes: refund.notes,
    requestedById: refund.requestedById,
    approvedById: refund.approvedById,
    approvedAt: refund.approvedAt,
    rejectedById: refund.rejectedById,
    rejectedAt: refund.rejectedAt,
    rejectionReason: refund.rejectionReason,
    attempts: refund.attempts.map(mapAttemptToDto),
    createdAt: refund.createdAt,
    updatedAt: refund.updatedAt,
  };
}

// =============================================================================
// REFUND SERVICE
// =============================================================================

@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
    @Optional()
    @Inject(NotificationService)
    private readonly notificationService?: NotificationService,
    @Optional()
    @Inject(FinanceService)
    private readonly financeService?: FinanceService,
  ) {}

  // ===========================================================================
  // CREATE REFUND
  // ===========================================================================

  /**
   * Creates a new Refund request for a CAPTURED payment on the given order.
   *
   * FINANCIAL INVARIANT ENFORCEMENT (Concurrency-safe):
   * Uses SELECT ... FOR UPDATE on the PaymentAttempt row to acquire an exclusive
   * row-level lock before calculating the remaining refundable balance.
   * Concurrent requests queue behind the lock and re-evaluate after commit.
   *
   * IDEMPOTENCY:
   * If an idempotencyKey is provided and already exists, returns the existing
   * Refund record without re-executing.
   *
   * AUTO-APPROVAL:
   * If amount <= AUTO_APPROVAL_THRESHOLD_PAISE, immediately dispatches to gateway.
   * Otherwise creates in REQUESTED state for secondary approval.
   */
  async createRefund(
    orderId: string,
    actor: MinimalUser,
    dto: CreateRefundDto,
  ): Promise<RefundDto> {
    // ── Validate input ─────────────────────────────────────────────────────
    if (!Number.isInteger(dto.amount) || dto.amount <= 0) {
      throw new BadRequestException('Refund amount must be a positive integer (paise).');
    }
    if (!dto.reason || dto.reason.trim().length < 5) {
      throw new BadRequestException('Refund reason must be at least 5 characters.');
    }

    // ── Idempotency check (fast path before acquiring lock) ────────────────
    if (dto.idempotencyKey) {
      const existing = await this.prisma.refund.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
        include: { attempts: true },
      });
      if (existing) {
        this.logger.log(
          `createRefund: Idempotent replay for key ${dto.idempotencyKey} → returning existing refund ${existing.id}`,
        );
        return mapRefundToDto(existing);
      }
    }

    // ── Fetch order and verify ownership / status ──────────────────────────
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { paymentAttempt: true },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found.`);
    }

    const paymentAttempt = order.paymentAttempt;

    if (!paymentAttempt || paymentAttempt.status !== PaymentStatus.CAPTURED) {
      throw new BadRequestException(
        `Order ${orderId} does not have a CAPTURED payment. Refunds require a CAPTURED payment.`,
      );
    }

    // ── Currency validation ────────────────────────────────────────────────
    if (paymentAttempt.currency !== 'INR') {
      throw new BadRequestException(
        `Refund currency mismatch. Expected INR, payment currency is ${paymentAttempt.currency}.`,
      );
    }

    // ── Execute inside a serialized transaction with row-level lock ────────
    let createdRefund: RefundWithAttempts;

    try {
      createdRefund = await this.prisma.$transaction(async (tx) => {
        // CRITICAL: Acquire exclusive row-level lock on PaymentAttempt.
        // Concurrent refund requests will block here until this transaction commits.
        const lockedAttempt = await tx.$queryRaw<
          Array<{ id: string; amount: number; status: string }>
        >`
          SELECT id, amount, status
          FROM payment_attempts
          WHERE id = ${paymentAttempt.id}
          FOR UPDATE
        `;

        if (!lockedAttempt.length || lockedAttempt[0]?.status !== 'CAPTURED') {
          throw new BadRequestException(
            `Payment attempt ${paymentAttempt.id} is not CAPTURED (status: ${lockedAttempt[0]?.status}). Cannot refund.`,
          );
        }

        const capturedAmount = lockedAttempt[0].amount;

        // Sum all existing committed and in-flight refunds (holding the lock).
        const existingCommitted = await tx.$queryRaw<Array<{ allocated: bigint }>>`
          SELECT COALESCE(SUM(amount), 0) AS allocated
          FROM refunds
          WHERE "paymentAttemptId" = ${paymentAttempt.id}
            AND status IN ('COMPLETED', 'PROCESSING', 'APPROVED', 'REQUESTED')
        `;

        const allocatedAmount = Number(existingCommitted[0]?.allocated ?? 0);
        const remainingBalance = capturedAmount - allocatedAmount;

        if (dto.amount > remainingBalance) {
          throw new BadRequestException(
            `OVER_REFUND_PROHIBITED: Requested refund of ${dto.amount} paise exceeds refundable balance of ${remainingBalance} paise (captured: ${capturedAmount}, already allocated: ${allocatedAmount}).`,
          );
        }

        // Determine refund type
        const refundType: RefundType =
          dto.amount === capturedAmount ? RefundType.FULL : RefundType.PARTIAL;

        // Determine initial status (auto-approval or pending approval)
        const autoApprove = dto.amount <= AUTO_APPROVAL_THRESHOLD_PAISE;
        const initialStatus: RefundStatus = autoApprove
          ? RefundStatus.PROCESSING
          : RefundStatus.REQUESTED;

        // Generate collision-resistant refund number (retry handled by unique constraint)
        let refundNumber = generateRefundNumber();
        let attempts = 0;
        while (attempts < 3) {
          const conflict = await tx.refund.findUnique({ where: { refundNumber } });
          if (!conflict) break;
          refundNumber = generateRefundNumber();
          attempts++;
        }

        // Create the Refund record
        const refund = await tx.refund.create({
          data: {
            refundNumber,
            orderId,
            paymentAttemptId: paymentAttempt.id,
            userId: order.userId,
            returnId: dto.returnId ?? null,
            source: dto.source,
            type: refundType,
            status: initialStatus,
            amount: dto.amount,
            approvedAmount: autoApprove ? dto.amount : null,
            refundedAmount: 0,
            currency: 'INR',
            reason: dto.reason.trim(),
            notes: dto.notes ?? null,
            requestedById: actor.id,
            approvedById: autoApprove ? actor.id : null,
            approvedAt: autoApprove ? new Date() : null,
            idempotencyKey: dto.idempotencyKey ?? null,
          },
          include: { attempts: true },
        });

        // Write audit log inside the same transaction
        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            actorRole: actor.role,
            actorEmail: actor.email,
            action: AuditAction.REFUND_REQUESTED,
            entityType: AuditEntityType.REFUND,
            entityId: refund.id,
            orderId,
            amount: dto.amount,
            currency: 'INR',
            reason: dto.reason.trim(),
            newValue: JSON.stringify({ status: initialStatus, refundNumber }),
            correlationId: dto.idempotencyKey,
          },
        });

        return refund;
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      // P2002 on idempotencyKey unique constraint = concurrent duplicate submission
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Race condition: concurrent duplicate key — return the existing record
        if (dto.idempotencyKey) {
          const existing = await this.prisma.refund.findUnique({
            where: { idempotencyKey: dto.idempotencyKey },
            include: { attempts: true },
          });
          if (existing) return mapRefundToDto(existing);
        }
        throw new ConflictException('A refund with this idempotency key already exists.');
      }
      throw error;
    }

    this.logger.log(
      `Refund created: ${createdRefund.refundNumber} (${createdRefund.status}) for order ${orderId}`,
    );

    // If auto-approved, dispatch to gateway immediately (outside the lock transaction)
    if (createdRefund.status === RefundStatus.PROCESSING) {
      await this.dispatchRefundToGateway(createdRefund, paymentAttempt, actor);
    }

    // Re-fetch to include any attempt created by dispatch
    const updated = await this.prisma.refund.findUniqueOrThrow({
      where: { id: createdRefund.id },
      include: { attempts: true },
    });

    return mapRefundToDto(updated);
  }

  // ===========================================================================
  // APPROVE REFUND
  // ===========================================================================

  /**
   * Approves a REQUESTED refund and dispatches it to the gateway.
   * Requires: refund.status === REQUESTED, actor has REFUNDS.APPROVE permission.
   * The approvedById must differ from requestedById (dual-control principle).
   */
  async approveRefund(
    refundId: string,
    actor: MinimalUser,
    dto: ApproveRefundDto,
  ): Promise<RefundDto> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: { attempts: true, paymentAttempt: true },
    });

    if (!refund) throw new NotFoundException(`Refund ${refundId} not found.`);

    if (refund.status !== RefundStatus.REQUESTED) {
      throw new BadRequestException(
        `Cannot approve refund in status ${refund.status}. Only REQUESTED refunds can be approved.`,
      );
    }

    // Dual-control: approver cannot be the same person who requested
    if (refund.requestedById === actor.id) {
      throw new ForbiddenException(
        'Dual-control violation: The approver cannot be the same actor who requested the refund.',
      );
    }

    const approvedAmount = dto.approvedAmount ?? refund.amount;
    if (approvedAmount <= 0 || approvedAmount > refund.amount) {
      throw new BadRequestException(
        `Approved amount must be between 1 and ${refund.amount} paise.`,
      );
    }

    const updated = await this.prisma.refund.update({
      where: { id: refundId },
      data: {
        status: RefundStatus.PROCESSING,
        approvedAmount,
        approvedById: actor.id,
        approvedAt: new Date(),
      },
      include: { attempts: true },
    });

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.REFUND_APPROVED,
      entityType: AuditEntityType.REFUND,
      entityId: refundId,
      orderId: refund.orderId,
      amount: approvedAmount,
      currency: 'INR',
      previousValue: { status: RefundStatus.REQUESTED },
      newValue: { status: RefundStatus.PROCESSING, approvedAmount },
    });

    // Dispatch to gateway
    const paymentAttempt = refund.paymentAttempt;
    await this.dispatchRefundToGateway(updated, paymentAttempt, actor);

    const final = await this.prisma.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: { attempts: true },
    });

    return mapRefundToDto(final);
  }

  // ===========================================================================
  // REJECT REFUND
  // ===========================================================================

  async rejectRefund(
    refundId: string,
    actor: MinimalUser,
    dto: RejectRefundDto,
  ): Promise<RefundDto> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: { attempts: true },
    });

    if (!refund) throw new NotFoundException(`Refund ${refundId} not found.`);

    if (refund.status !== RefundStatus.REQUESTED) {
      throw new BadRequestException(
        `Cannot reject refund in status ${refund.status}. Only REQUESTED refunds can be rejected.`,
      );
    }

    if (!dto.rejectionReason || dto.rejectionReason.trim().length < 5) {
      throw new BadRequestException('Rejection reason must be at least 5 characters.');
    }

    const updated = await this.prisma.refund.update({
      where: { id: refundId },
      data: {
        status: RefundStatus.REJECTED,
        rejectedById: actor.id,
        rejectedAt: new Date(),
        rejectionReason: dto.rejectionReason.trim(),
      },
      include: { attempts: true },
    });

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.REFUND_REJECTED,
      entityType: AuditEntityType.REFUND,
      entityId: refundId,
      orderId: refund.orderId,
      amount: refund.amount,
      currency: 'INR',
      reason: dto.rejectionReason.trim(),
      previousValue: { status: RefundStatus.REQUESTED },
      newValue: { status: RefundStatus.REJECTED },
    });

    return mapRefundToDto(updated);
  }

  // ===========================================================================
  // CANCEL REFUND (admin cancels a REQUESTED refund before dispatch)
  // ===========================================================================

  async cancelRefund(refundId: string, actor: MinimalUser): Promise<RefundDto> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: { attempts: true },
    });

    if (!refund) throw new NotFoundException(`Refund ${refundId} not found.`);

    if (refund.status !== RefundStatus.REQUESTED) {
      throw new BadRequestException(
        `Cannot cancel refund in status ${refund.status}. Only REQUESTED refunds can be cancelled.`,
      );
    }

    const updated = await this.prisma.refund.update({
      where: { id: refundId },
      data: { status: RefundStatus.CANCELLED },
      include: { attempts: true },
    });

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.REFUND_CANCELLED,
      entityType: AuditEntityType.REFUND,
      entityId: refundId,
      orderId: refund.orderId,
      amount: refund.amount,
      currency: 'INR',
      previousValue: { status: RefundStatus.REQUESTED },
      newValue: { status: RefundStatus.CANCELLED },
    });

    return mapRefundToDto(updated);
  }

  // ===========================================================================
  // RECONCILE REFUND ATTEMPT
  // ===========================================================================

  /**
   * Manually resolves a RECONCILIATION_REQUIRED RefundAttempt.
   * Admin manually confirms the gateway status via out-of-band verification.
   */
  async reconcileRefundAttempt(
    refundId: string,
    attemptId: string,
    actor: MinimalUser,
    dto: ReconcileRefundAttemptDto,
  ): Promise<RefundDto> {
    const attempt = await this.prisma.refundAttempt.findFirst({
      where: { id: attemptId, refundId },
    });

    if (!attempt) {
      throw new NotFoundException(`RefundAttempt ${attemptId} not found for refund ${refundId}.`);
    }

    if (attempt.status !== RefundAttemptStatus.RECONCILIATION_REQUIRED) {
      throw new BadRequestException(
        `Cannot reconcile attempt in status ${attempt.status}. Only RECONCILIATION_REQUIRED attempts can be reconciled.`,
      );
    }

    const refund = await this.prisma.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: { attempts: true },
    });

    const newAttemptStatus =
      dto.resolution === 'PROCESSED'
        ? RefundAttemptStatus.PROCESSED
        : RefundAttemptStatus.FAILED;

    const newRefundStatus =
      dto.resolution === 'PROCESSED' ? RefundStatus.COMPLETED : RefundStatus.FAILED;

    await this.prisma.$transaction(async (tx) => {
      await tx.refundAttempt.update({
        where: { id: attemptId },
        data: {
          status: newAttemptStatus,
          reconciledAt: new Date(),
          reconciledBy: actor.id,
        },
      });

      await tx.refund.update({
        where: { id: refundId },
        data: {
          status: newRefundStatus,
          refundedAmount: dto.resolution === 'PROCESSED' ? refund.amount : refund.refundedAmount,
        },
      });

      if (this.financeService && newRefundStatus === RefundStatus.COMPLETED) {
        await this.financeService.postRefundCompletedInTransaction(
          {
            id: refundId,
            amount: refund.amount,
            orderId: refund.orderId,
            currency: 'INR',
          },
          tx,
          actor.id,
        );
      }

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          actorEmail: actor.email,
          action: AuditAction.REFUND_RECONCILED,
          entityType: AuditEntityType.REFUND,
          entityId: refundId,
          orderId: refund.orderId,
          amount: refund.amount,
          currency: 'INR',
          reason: dto.notes,
          previousValue: JSON.stringify({ status: RefundStatus.PROCESSING }),
          newValue: JSON.stringify({ status: newRefundStatus, resolution: dto.resolution }),
        },
      });

      if (this.notificationService && newRefundStatus === RefundStatus.COMPLETED) {
        const order = await tx.order.findUnique({
          where: { id: refund.orderId },
          select: { orderNumber: true, userId: true },
        });

        if (order) {
          await this.notificationService.createInAppNotification(
            {
              userId: order.userId,
              eventType: NotificationEventType.REFUND_COMPLETED,
              category: NotificationCategory.TRANSACTIONAL,
              entityType: 'refund',
              entityId: refund.id,
              context: {
                refundNumber: refund.refundNumber,
                orderNumber: order.orderNumber,
                amount: String(dto.resolution === 'PROCESSED' ? refund.amount : refund.refundedAmount),
              },
              actionUrl: `/orders/${refund.orderId}`,
            },
            tx,
          );
        }
      }
    });

    const updated = await this.prisma.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: { attempts: true },
    });

    return mapRefundToDto(updated);
  }

  // ===========================================================================
  // GET REFUNDS FOR ORDER
  // ===========================================================================

  async getRefundsForOrder(orderId: string): Promise<OrderRefundSummaryDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        paymentAttempt: true,
        refunds: { include: { attempts: true }, orderBy: { createdAt: 'asc' } },
      },
    });

    if (!order) throw new NotFoundException(`Order ${orderId} not found.`);

    const capturedAmount = order.paymentAttempt?.amount ?? 0;
    const totalRefundedAmount = order.refunds
      .filter((r) => r.status === RefundStatus.COMPLETED)
      .reduce((sum, r) => sum + r.refundedAmount, 0);

    const allocatedAmount = order.refunds
      .filter((r) =>
        (
          [
            RefundStatus.COMPLETED,
            RefundStatus.PROCESSING,
            RefundStatus.APPROVED,
            RefundStatus.REQUESTED,
          ] as RefundStatus[]
        ).includes(r.status),
      )
      .reduce((sum, r) => sum + r.amount, 0);

    const remainingRefundableBalance = Math.max(0, capturedAmount - allocatedAmount);

    return {
      refunds: order.refunds.map(mapRefundToDto),
      capturedAmount,
      totalRefundedAmount,
      remainingRefundableBalance,
      currency: 'INR',
    };
  }

  // ===========================================================================
  // GATEWAY DISPATCH (private)
  // ===========================================================================

  /**
   * Dispatches a PROCESSING refund to the payment gateway.
   * Creates a RefundAttempt record and calls provider.createRefund().
   *
   * On network error/timeout: marks attempt as RECONCILIATION_REQUIRED.
   * On permanent gateway failure: marks attempt as FAILED, refund as FAILED.
   * On success: marks attempt as PROCESSED, refund as COMPLETED.
   */
  private async dispatchRefundToGateway(
    refund: RefundWithAttempts,
    paymentAttempt: { id: string; providerPaymentId: string | null; provider: string },
    actor: MinimalUser,
  ): Promise<void> {
    if (!paymentAttempt.providerPaymentId) {
      this.logger.error(
        `Refund ${refund.id}: Cannot dispatch — PaymentAttempt ${paymentAttempt.id} has no providerPaymentId.`,
      );
      await this.prisma.refund.update({
        where: { id: refund.id },
        data: { status: RefundStatus.FAILED },
      });
      return;
    }

    // Check existing attempt count
    const existingAttemptCount = await this.prisma.refundAttempt.count({
      where: { refundId: refund.id },
    });

    if (existingAttemptCount >= MAX_REFUND_ATTEMPTS) {
      this.logger.error(
        `Refund ${refund.id}: Max attempts (${MAX_REFUND_ATTEMPTS}) reached. Marking as permanent FAILED.`,
      );
      await this.prisma.refund.update({
        where: { id: refund.id },
        data: { status: RefundStatus.FAILED },
      });
      await this.auditService.logEvent({
        actorId: actor.id,
        actorRole: actor.role,
        action: AuditAction.REFUND_FAILED,
        entityType: AuditEntityType.REFUND,
        entityId: refund.id,
        orderId: refund.orderId,
        amount: refund.amount,
        currency: 'INR',
        reason: `Max gateway attempts (${MAX_REFUND_ATTEMPTS}) reached.`,
      });
      return;
    }

    const attemptNumber = existingAttemptCount + 1;
    const idempotencyKey = `ref_att_${refund.id}_${attemptNumber}`;
    const amount = refund.approvedAmount ?? refund.amount;

    // Create the RefundAttempt record
    const attempt = await this.prisma.refundAttempt.create({
      data: {
        refundId: refund.id,
        paymentAttemptId: paymentAttempt.id,
        attemptNumber,
        idempotencyKey,
        provider: paymentAttempt.provider,
        amount,
        currency: 'INR',
        status: RefundAttemptStatus.INITIATED,
      },
    });

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.REFUND_ATTEMPT_INITIATED,
      entityType: AuditEntityType.REFUND,
      entityId: refund.id,
      orderId: refund.orderId,
      amount,
      currency: 'INR',
      correlationId: idempotencyKey,
      newValue: { attemptId: attempt.id, attemptNumber },
    });

    // Call the gateway
    try {
      const result = await this.paymentProvider.createRefund({
        paymentAttemptId: paymentAttempt.id,
        providerPaymentId: paymentAttempt.providerPaymentId,
        amount,
        currency: 'INR',
        receipt: refund.refundNumber,
        notes: { refundId: refund.id, orderId: refund.orderId },
        idempotencyKey,
      });

      if (result.status === 'PROCESSED') {
        // Gateway confirmed settlement
        await this.prisma.$transaction(async (tx) => {
          await tx.refundAttempt.update({
            where: { id: attempt.id },
            data: {
              status: RefundAttemptStatus.PROCESSED,
              providerRefundId: result.providerRefundId,
              rawResponse: (result.rawResponse as Prisma.InputJsonObject) ?? undefined,
            },
          });
          await tx.refund.update({
            where: { id: refund.id },
            data: {
              status: RefundStatus.COMPLETED,
              refundedAmount: amount,
            },
          });

          if (this.financeService) {
            await this.financeService.postRefundCompletedInTransaction(
              {
                id: refund.id,
                amount,
                orderId: refund.orderId,
                currency: 'INR',
              },
              tx,
              actor.id,
            );
          }
          await tx.auditLog.create({
            data: {
              actorId: actor.id,
              actorRole: actor.role,
              action: AuditAction.REFUND_COMPLETED,
              entityType: AuditEntityType.REFUND,
              entityId: refund.id,
              orderId: refund.orderId,
              amount,
              currency: 'INR',
              correlationId: idempotencyKey,
              newValue: JSON.stringify({
                status: RefundStatus.COMPLETED,
                providerRefundId: result.providerRefundId,
              }),
            },
          });

          if (this.notificationService) {
            const order = await tx.order.findUnique({
              where: { id: refund.orderId },
              select: { orderNumber: true, userId: true },
            });

            if (order) {
              await this.notificationService.createInAppNotification(
                {
                  userId: order.userId,
                  eventType: NotificationEventType.REFUND_COMPLETED,
                  category: NotificationCategory.TRANSACTIONAL,
                  entityType: 'refund',
                  entityId: refund.id,
                  context: {
                    refundNumber: refund.refundNumber,
                    orderNumber: order.orderNumber,
                    amount: String(amount),
                  },
                  actionUrl: `/orders/${refund.orderId}`,
                },
                tx,
              );
            }
          }
        });

        this.logger.log(
          `Refund ${refund.refundNumber} COMPLETED via provider refund ID ${result.providerRefundId}`,
        );
      } else if (result.status === 'FAILED') {
        // Permanent gateway rejection
        await this.prisma.$transaction(async (tx) => {
          await tx.refundAttempt.update({
            where: { id: attempt.id },
            data: {
              status: RefundAttemptStatus.FAILED,
              providerRefundId: result.providerRefundId,
              gatewayErrorCode: result.errorCode ?? null,
              gatewayErrorMessage: result.errorMessage ?? null,
              rawResponse: (result.rawResponse as Prisma.InputJsonObject) ?? undefined,
            },
          });
          await tx.refund.update({
            where: { id: refund.id },
            data: { status: RefundStatus.FAILED },
          });
          await tx.auditLog.create({
            data: {
              actorId: actor.id,
              actorRole: actor.role,
              action: AuditAction.REFUND_FAILED,
              entityType: AuditEntityType.REFUND,
              entityId: refund.id,
              orderId: refund.orderId,
              amount,
              currency: 'INR',
              correlationId: idempotencyKey,
              newValue: JSON.stringify({
                status: RefundStatus.FAILED,
                errorCode: result.errorCode,
              }),
            },
          });
        });

        this.logger.warn(
          `Refund ${refund.refundNumber} FAILED at gateway: ${result.errorCode ?? 'unknown'} — ${result.errorMessage ?? ''}`,
        );
      } else {
        // status === 'PENDING' — gateway acknowledged, awaiting async settlement
        await this.prisma.refundAttempt.update({
          where: { id: attempt.id },
          data: {
            status: RefundAttemptStatus.PENDING,
            providerRefundId: result.providerRefundId,
            rawResponse: (result.rawResponse as Prisma.InputJsonObject) ?? undefined,
          },
        });

        this.logger.log(
          `Refund ${refund.refundNumber} is PENDING at gateway (async settlement). Attempt ${attempt.id} status: PENDING.`,
        );
      }
    } catch (dispatchError: unknown) {
      // CRITICAL: Do NOT mark as FAILED on network error — gateway may have processed it.
      // Mark as RECONCILIATION_REQUIRED for admin/cron to resolve.
      const errorMessage =
        dispatchError instanceof Error
          ? dispatchError.message
          : 'Unknown gateway dispatch error.';

      this.logger.error(
        `Refund ${refund.refundNumber}: Gateway dispatch error (marking RECONCILIATION_REQUIRED): ${errorMessage}`,
      );

      await this.prisma.refundAttempt.update({
        where: { id: attempt.id },
        data: {
          status: RefundAttemptStatus.RECONCILIATION_REQUIRED,
          gatewayErrorMessage: errorMessage,
        },
      });

      await this.auditService.logEvent({
        actorId: actor.id,
        actorRole: actor.role,
        action: AuditAction.REFUND_RECONCILIATION_REQUIRED,
        entityType: AuditEntityType.REFUND,
        entityId: refund.id,
        orderId: refund.orderId,
        amount,
        currency: 'INR',
        correlationId: idempotencyKey,
        reason: errorMessage,
        metadata: { attemptId: attempt.id },
      });
    }
  }
}
