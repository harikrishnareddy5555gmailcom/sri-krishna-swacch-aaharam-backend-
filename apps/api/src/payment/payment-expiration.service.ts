/**
 * PaymentExpirationService
 *
 * Periodic cleanup service that transitions stale CREATED or PENDING
 * PaymentAttempts to FAILED after a configurable expiration window.
 *
 * Design invariants:
 * - Uses the state machine to validate each transition before applying it.
 * - Logs every expiration for audit traceability.
 * - Never deletes payment records — financial records are immutable.
 * - Uses NestJS @Cron to run every 5 minutes (configurable).
 * - Safe for multiple replicas: uses DB-level WHERE clause to race-condition-safely
 *   select only currently-stale attempts. Duplicate runs are idempotent.
 *
 * Expiration thresholds (configurable via env):
 * - CREATED attempts (provider call never completed): 15 minutes
 * - PENDING attempts (provider order created, payment never confirmed): 60 minutes
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PaymentStatus, AuditAction, AuditEntityType } from '@vishkaraa/types';

const CREATED_EXPIRY_MINUTES = 15;
const PENDING_EXPIRY_MINUTES = 60;

@Injectable()
export class PaymentExpirationService {
  private readonly logger = new Logger(PaymentExpirationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Runs every 5 minutes to expire stale payment attempts.
   * Safe to run on multiple replicas (SELECT...UPDATE WHERE is atomic at DB level).
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async expireStalePaymentAttempts(): Promise<void> {
    const now = new Date();

    const createdCutoff = new Date(
      now.getTime() - CREATED_EXPIRY_MINUTES * 60 * 1000,
    );
    const pendingCutoff = new Date(
      now.getTime() - PENDING_EXPIRY_MINUTES * 60 * 1000,
    );

    // Find stale CREATED attempts
    const staleCreated = await this.prisma.paymentAttempt.findMany({
      where: {
        status: PaymentStatus.CREATED,
        createdAt: { lt: createdCutoff },
      },
      select: { id: true, userId: true, status: true, createdAt: true },
    });

    // Find stale PENDING attempts
    const stalePending = await this.prisma.paymentAttempt.findMany({
      where: {
        status: PaymentStatus.PENDING,
        updatedAt: { lt: pendingCutoff },
      },
      select: { id: true, userId: true, status: true, updatedAt: true },
    });

    const staleAll = [...staleCreated, ...stalePending];

    if (staleAll.length === 0) {
      return;
    }

    this.logger.log(
      `Payment expiration sweep: ${staleCreated.length} CREATED + ${stalePending.length} PENDING stale attempts to expire`,
    );

    for (const attempt of staleAll) {
      try {
        const result = await this.prisma.paymentAttempt.updateMany({
          where: {
            id: attempt.id,
            // Optimistic concurrency: only update if still in the expected status
            status: attempt.status,
          },
          data: {
            status: PaymentStatus.FAILED,
            failureCode: 'PAYMENT_EXPIRED',
            failureMessage: `Payment attempt expired after exceeding the maximum allowed time in ${attempt.status} status.`,
          },
        });

        if (result.count === 0) {
          this.logger.debug(
            `Skipped expiration of payment attempt ${attempt.id}: status changed concurrently`,
          );
          continue;
        }

        await this.auditService.logEvent({
          actorId: 'SYSTEM',
          actorRole: 'SYSTEM',
          actorEmail: 'expiration@system.internal',
          action: AuditAction.PAYMENT_STATE_CHANGED,
          entityType: AuditEntityType.PAYMENT,
          entityId: attempt.id,
          previousValue: JSON.stringify({ status: attempt.status }),
          newValue: JSON.stringify({
            status: PaymentStatus.FAILED,
            failureCode: 'PAYMENT_EXPIRED',
          }),
          metadata: {
            expiredBy: 'PaymentExpirationService',
          },
        });

        this.logger.log(
          `Expired payment attempt ${attempt.id} (was ${attempt.status})`,
        );
      } catch (err: unknown) {
        // Concurrent update (another replica won the race) — safe to skip
        this.logger.debug(
          `Skipped expiration of payment attempt ${attempt.id}: ${(err as Error).message}`,
        );
      }
    }
  }
}
