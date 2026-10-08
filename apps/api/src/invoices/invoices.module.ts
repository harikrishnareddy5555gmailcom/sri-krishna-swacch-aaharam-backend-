import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { InvoiceService } from './invoices.service.js';
import { InvoiceDocumentService } from './invoice-document.service.js';
import { InvoicesController } from './invoices.controller.js';
import { AdminInvoicesController } from './admin-invoices.controller.js';

@Module({
  imports: [
    DatabaseModule,
    PermissionsModule,
    AuditModule,
  ],
  controllers: [
    InvoicesController,
    AdminInvoicesController,
  ],
  providers: [
    InvoiceService,
    InvoiceDocumentService,
  ],
  exports: [
    InvoiceService,
    InvoiceDocumentService,
  ],
})
export class InvoicesModule {}
