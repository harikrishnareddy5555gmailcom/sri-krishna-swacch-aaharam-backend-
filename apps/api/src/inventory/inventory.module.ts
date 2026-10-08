import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';
import { InventoryRecoveryService } from './inventory-recovery.service.js';
import { AdminInventoryController } from './admin-inventory.controller.js';
import { DatabaseModule } from '../database/database.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [DatabaseModule, PermissionsModule, AuditModule],
  controllers: [AdminInventoryController],
  providers: [InventoryService, InventoryRecoveryService],
  exports: [InventoryService],
})
export class InventoryModule {}
