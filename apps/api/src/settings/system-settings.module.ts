import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { SystemSettingsController } from './system-settings.controller.js';
import { SystemSettingsService } from './system-settings.service.js';

@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [SystemSettingsController],
  providers: [SystemSettingsService],
  exports: [SystemSettingsService],
})
export class SystemSettingsModule {}
