/**
 * VISHKARAA — ORDER RECOVERY SERVICE (Phase 08A Durable Recovery)
 *
 * Provides a modular-monolith background reconciliation mechanism that guarantees
 * eventual finalization for any CAPTURED PaymentAttempt that has no associated Order
 * (e.g. due to webhook timeout, pod restart, or transient database lock failure).
 *
 * Design Invariants:
 * 1. Leverages existing OrderService.finalizeFromPayment() strict idempotency.
 * 2. Uses a configurable grace period (default 30s) to avoid racing in-flight webhooks.
 * 3. Bounded batch size (50 records per sweep) to maintain deterministic performance.
 * 4. Zero external dependencies: no Kafka, no Redis, no outbox table, no microservices.
 * 5. Safe for multi-replica operation: OrderService transaction and database UNIQUE constraints
 *    guarantee at-most-one Order creation even if two recovery sweeps run concurrently.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service.js';
import { OrderService } from './orders.service.js';
import { PaymentStatus } from '@prisma/client';

export const DEFAULT_RECOVERY_GRACE_PERIOD_MS = 30_000; // 30 seconds
export const DEFAULT_RECOVERY_BATCH_SIZE = 50;

export interface RecoverySweepResult {
  scanned: number;
  recovered: number;
  failed: number;
}

@Injectable()
export class OrderRecoveryService {
  private readonly logger = new Logger(OrderRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderService: OrderService,
  ) {}

  /**
   * Periodic reconciliation cron job: runs every minute to detect and finalize
   * any orphaned CAPTURED PaymentAttempt records that have no associated Order.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleCronRecovery(): Promise<void> {
    try {
      const result = await this.recoverOrphanedCapturedPayments();
      if (result.scanned > 0) {
        this.logger.log(
          `[ORDER RECOVERY] Sweep completed: scanned ${result.scanned}, recovered ${result.recovered}, failed ${result.failed}`,
        );
      }
    } catch (err: unknown) {
      this.logger.error(
        `[ORDER RECOVERY] Unexpected error during recovery sweep: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /**
   * Authoritative recovery sweep.
   * Scans for CAPTURED PaymentAttempt records where order is null and updatedAt is
   * older than the grace period cutoff.
   *
   * @param gracePeriodMs Minimum age in ms before an attempt is considered orphaned
   * @param batchSize Maximum number of orphaned attempts to process in a single sweep
   */
  async recoverOrphanedCapturedPayments(
    gracePeriodMs: number = DEFAULT_RECOVERY_GRACE_PERIOD_MS,
    batchSize: number = DEFAULT_RECOVERY_BATCH_SIZE,
  ): Promise<RecoverySweepResult> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - gracePeriodMs);

    // Find orphaned CAPTURED payment attempts (order relation is null)
    const orphanedAttempts = await this.prisma.paymentAttempt.findMany({
      where: {
        status: PaymentStatus.CAPTURED,
        updatedAt: { lt: cutoff },
        order: null, // Prisma relation filter: no associated Order
      },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      select: {
        id: true,
        userId: true,
        amount: true,
        currency: true,
        updatedAt: true,
      },
    });

    if (orphanedAttempts.length === 0) {
      return { scanned: 0, recovered: 0, failed: 0 };
    }

    this.logger.warn(
      `[ORDER RECOVERY] Found ${orphanedAttempts.length} orphaned CAPTURED payment attempts needing finalization`,
    );

    let recovered = 0;
    let failed = 0;

    for (const attempt of orphanedAttempts) {
      try {
        const order = await this.orderService.finalizeFromPayment(attempt.id);
        recovered++;
        this.logger.log(
          `[ORDER RECOVERY] Successfully finalized orphaned payment ${attempt.id} -> Order ${order.orderNumber} (orderId=${order.id})`,
        );
      } catch (err: unknown) {
        failed++;
        this.logger.error(
          `[ORDER RECOVERY FAILED] Failed to finalize orphaned payment attempt ${attempt.id}: ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
    }

    return {
      scanned: orphanedAttempts.length,
      recovered,
      failed,
    };
  }
}
