import { Module } from '@nestjs/common';
import { ReturnService } from './return.service.js';
import { ReturnsController, AdminReturnsController } from './returns.controller.js';
import { DatabaseModule } from '../database/database.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { RefundsModule } from '../refunds/refunds.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';

/**
 * Returns Module — Phase 10B
 *
 * Implements the Returns, RMA, and Warehouse Inspection domain:
 *   - createReturn: customer & admin return request with 7-day eligibility & item quantity checks
 *   - approveReturn: admin review and reverse logistics RMA approval
 *   - rejectReturn: admin denial with mandatory justification
 *   - receiveReturn: warehouse dock receipt and scanned quantity tracking
 *   - inspectReturn: item-by-item condition & disposition grading with pro-rata paise calculation
 *   - cancelReturn: customer cancellation in REQUESTED state, admin operational override
 *   - Crash-safe Phase 09 refund integration via deterministic idempotency keys
 */
@Module({
  imports: [
    DatabaseModule,
    PermissionsModule,
    AuditModule,
    RefundsModule,
    InventoryModule,
  ],
  controllers: [ReturnsController, AdminReturnsController],
  providers: [ReturnService],
  exports: [ReturnService],
})
export class ReturnsModule {}
