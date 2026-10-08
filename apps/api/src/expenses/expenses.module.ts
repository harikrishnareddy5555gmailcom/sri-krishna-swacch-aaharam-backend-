import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { ExpensesRepository } from './expenses.repository.js';
import { ExpensesService } from './expenses.service.js';
import { ExpensesController } from './expenses.controller.js';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    FinanceModule,
    PermissionsModule,
    FeaturesModule,
  ],
  controllers: [ExpensesController],
  providers: [ExpensesRepository, ExpensesService],
  exports: [ExpensesService, ExpensesRepository],
})
export class ExpensesModule {}
