import { Module } from '@nestjs/common';
import { RefundService } from './refund.service.js';
import { AdminRefundsController, AdminRefundOperationsController } from './admin-refunds.controller.js';
import { DatabaseModule } from '../database/database.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { PaymentModule } from '../payment/payment.module.js';
import { FinanceModule } from '../finance/finance.module.js';

/**
 * Refunds Module — Phase 09B & Phase 15B
 *
 * Implements the Refund & Financial Reconciliation domain:
 *   - createRefund: admin-initiated refund with concurrency-safe balance check
 *   - approveRefund: dual-control approval for high-value refunds
 *   - rejectRefund: admin denial of refund request
 *   - cancelRefund: cancel a pending request before gateway dispatch
 *   - reconcileRefundAttempt: manually resolve RECONCILIATION_REQUIRED attempts
 *   - getRefundsForOrder: admin view of all refunds + balance summary
 *   - postRefundCompletedInTransaction: atomic financial ledger refund posting
 *
 * Financial Invariants:
 *   - SELECT ... FOR UPDATE on PaymentAttempt prevents concurrent over-refunding
 *   - idempotencyKey deduplication at three levels: client, gateway, webhook
 *   - All monetary values in integer paise (no floating point)
 *   - Audit records written atomically with each state transition
 */
@Module({
  imports: [
    DatabaseModule,
    FeaturesModule,
    PermissionsModule,
    AuditModule,
    PaymentModule,
    FinanceModule,
  ],
  controllers: [AdminRefundsController, AdminRefundOperationsController],
  providers: [RefundService],
  exports: [RefundService],
})
export class RefundsModule {}
