import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { FinanceRepository } from './finance.repository.js';
import { FinanceService } from './finance.service.js';
import { AdminFinanceController } from './admin-finance.controller.js';

import { FinanceExportService } from './finance-export.service.js';
import { FinanceControlsService } from './finance-controls.service.js';

@Module({
  imports: [
    DatabaseModule,
    FeaturesModule,
    PermissionsModule,
    AuditModule,
  ],
  controllers: [
    AdminFinanceController,
  ],
  providers: [
    FinanceRepository,
    FinanceService,
    FinanceExportService,
    FinanceControlsService,
  ],
  exports: [
    FinanceRepository,
    FinanceService,
    FinanceExportService,
    FinanceControlsService,
  ],
})
export class FinanceModule {}
