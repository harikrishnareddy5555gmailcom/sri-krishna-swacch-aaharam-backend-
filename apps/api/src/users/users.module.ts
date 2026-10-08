import { Module } from '@nestjs/common';
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';
import { AdminUsersController } from './admin-users.controller.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';
import { FeaturesModule } from '../features/features.module.js';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    PermissionsModule,
    FeaturesModule,
  ],
  controllers: [UsersController, AdminUsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
