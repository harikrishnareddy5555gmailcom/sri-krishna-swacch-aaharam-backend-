import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';

@Module({
  imports: [
    DatabaseModule,
    FeaturesModule,
    AuditModule,
    PermissionsModule,
    InventoryModule,
  ],
  controllers: [CheckoutController],
  providers: [CheckoutService],
  exports: [CheckoutService],
})
export class CheckoutModule {}
