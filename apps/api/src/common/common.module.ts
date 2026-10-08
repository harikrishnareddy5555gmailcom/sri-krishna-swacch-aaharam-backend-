import { Global, Module } from '@nestjs/common';
import { EntityOwnershipService } from './services/entity-ownership.service.js';
import { ResourceOwnerGuard } from './guards/resource-owner.guard.js';
import { DatabaseModule } from '../database/database.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';

@Global()
@Module({
  imports: [DatabaseModule, PermissionsModule],
  providers: [EntityOwnershipService, ResourceOwnerGuard],
  exports: [EntityOwnershipService, ResourceOwnerGuard],
})
export class CommonModule {}
