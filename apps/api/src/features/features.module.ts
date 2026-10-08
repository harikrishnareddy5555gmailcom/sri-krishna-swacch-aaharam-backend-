import { Module } from '@nestjs/common';
import { FeaturesService } from './features.service.js';
import { FeaturesController } from './features.controller.js';
import { FeaturesGuard } from '../auth/guards/features.guard.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';

@Module({
  imports: [DatabaseModule, AuditModule, PermissionsModule],
  controllers: [FeaturesController],
  providers: [FeaturesService, FeaturesGuard],
  exports: [FeaturesService, FeaturesGuard],
})
export class FeaturesModule {}
