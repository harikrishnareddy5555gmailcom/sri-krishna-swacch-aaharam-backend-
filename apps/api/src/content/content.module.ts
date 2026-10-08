import { Module } from '@nestjs/common';
import { ContentService } from './content.service.js';
import { ContentController } from './content.controller.js';
import { PermissionsModule } from '../permissions/permissions.module.js';

@Module({
  imports: [PermissionsModule],
  controllers: [ContentController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}
