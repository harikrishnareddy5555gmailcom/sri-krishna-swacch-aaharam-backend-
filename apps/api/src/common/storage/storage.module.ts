import { Module } from '@nestjs/common';
import { STORAGE_PROVIDER } from './storage-provider.interface.js';
import { CloudflareR2StorageProvider } from './cloudflare-r2-storage.provider.js';
import { StorageService } from './storage.service.js';
import { AuditModule } from '../../audit/audit.module.js';

@Module({
  imports: [AuditModule],
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useClass: CloudflareR2StorageProvider,
    },
    StorageService,
  ],
  exports: [StorageService, STORAGE_PROVIDER],
})
export class StorageModule {}
