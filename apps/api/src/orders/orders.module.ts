import { Module } from '@nestjs/common';
import { OrderService } from './orders.service.js';
import { OrderRecoveryService } from './order-recovery.service.js';
import { OrdersController } from './orders.controller.js';
import { AdminOrdersController } from './admin-orders.controller.js';
import { DatabaseModule } from '../database/database.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';

import { InvoicesModule } from '../invoices/invoices.module.js';
import { FinanceModule } from '../finance/finance.module.js';

/**
 * Orders Module — Phase 08A & 08B & Phase 12 Stage 12C & Phase 15B
 *
 * Implements Order Finalization & Order Operations:
 * - finalizeFromPayment: CAPTURED PaymentAttempt → exactly one CONFIRMED Order + atomic Invoice + atomic Financial SALE
 * - getUserOrders: paginated user order listing
 * - getOrderById: ownership-guarded order retrieval
 * - getOrderByNumber: ownership-guarded retrieval by human-readable number
 * - adminGetOrders: permission-governed order listing & search for admins
 * - adminGetOrderById: operational order inspection with payment references & audit trail
 * - updateOrderStatus: administrative state machine transitions with atomic audit
 * - OrderRecoveryService: periodic durable recovery for orphaned CAPTURED attempts
 */
@Module({
  imports:     [DatabaseModule, FeaturesModule, PermissionsModule, AuditModule, InventoryModule, InvoicesModule, FinanceModule],
  controllers: [OrdersController, AdminOrdersController],
  providers:   [OrderService, OrderRecoveryService],
  exports:     [OrderService, OrderRecoveryService],
})
export class OrdersModule {}
