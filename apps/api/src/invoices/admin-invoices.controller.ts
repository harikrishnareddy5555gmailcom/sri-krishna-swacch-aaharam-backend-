import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { InvoiceService } from './invoices.service.js';
import { InvoiceDocumentService } from './invoice-document.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';
import { Permissions, type InvoiceDto, type UserRole } from '@vishkaraa/types';
import type { MinimalUser } from '../permissions/permissions.service.js';
import { CancelInvoiceDto } from './dto/cancel-invoice.dto.js';
import { AdminInvoiceQueryDto } from './dto/admin-invoice-query.dto.js';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    role: string;
    email: string;
  };
}

function extractUser(req: Request): MinimalUser {
  const user = (req as AuthenticatedRequest).user;
  return {
    id: user.id,
    role: user.role as UserRole,
    email: user.email,
  };
}

function getSafePdfFilename(invoiceNumber: string | undefined, fallbackId: string): string {
  const cleanId = (invoiceNumber || fallbackId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `Vishkaraa-Invoice-${cleanId}.pdf`;
}

/**
 * Admin Invoices Controller — Phase 12
 *
 * Gated by centralized PermissionsGuard and explicit permission checks:
 * - INVOICES.VIEW for listing and inspecting invoices
 * - INVOICES.MANAGE for cancellation and manual issuance
 */
@Controller('admin/invoices')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminInvoicesController {
  constructor(
    private readonly invoiceService: InvoiceService,
    private readonly invoiceDocumentService: InvoiceDocumentService,
  ) {}

  /**
   * GET /admin/invoices
   * List invoices with pagination, status, user, and search filters.
   */
  @Get()
  @RequirePermissions(Permissions.INVOICES_VIEW)
  @HttpCode(HttpStatus.OK)
  async listInvoices(
    @Req() req: Request,
    @Query() query: AdminInvoiceQueryDto,
  ): Promise<{ items: InvoiceDto[]; total: number; page: number; limit: number }> {
    const user = extractUser(req);
    return this.invoiceService.listInvoices(query, user);
  }

  /**
   * GET /admin/invoices/:id
   * Retrieve full invoice details.
   */
  @Get(':id')
  @RequirePermissions(Permissions.INVOICES_VIEW)
  @HttpCode(HttpStatus.OK)
  async getInvoiceById(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<InvoiceDto> {
    const user = extractUser(req);
    return this.invoiceService.getInvoiceById(id, user);
  }

  /**
   * GET /admin/invoices/:id/pdf
   * Download or stream authoritative PDF representation of the invoice snapshot (requires INVOICES.VIEW).
   */
  @Get(':id/pdf')
  @RequirePermissions(Permissions.INVOICES_VIEW)
  async getInvoicePdf(
    @Req() req: Request,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const user = extractUser(req);
    const invoice = await this.invoiceService.getInvoiceById(id, user);
    const pdfBuffer = await this.invoiceDocumentService.generatePdf(invoice);

    const filename = getSafePdfFilename(invoice.invoiceNumber, id);
    const dispositionType = req.query['disposition'] === 'inline' ? 'inline' : 'attachment';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${dispositionType}; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.end(pdfBuffer);
  }

  /**
   * POST /admin/invoices/:id/cancel
   * Cancel an issued invoice with audit logging.
   */
  @Post(':id/cancel')
  @RequirePermissions(Permissions.INVOICES_MANAGE)
  @HttpCode(HttpStatus.OK)
  async cancelInvoice(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: CancelInvoiceDto,
  ): Promise<InvoiceDto> {
    const user = extractUser(req);
    return this.invoiceService.cancelInvoice(id, body.reason, user);
  }

  /**
   * POST /admin/invoices/order/:orderId/issue
   * Explicitly issue invoice for an already finalized order.
   */
  @Post('order/:orderId/issue')
  @RequirePermissions(Permissions.INVOICES_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  async issueInvoiceForOrder(
    @Req() req: Request,
    @Param('orderId') orderId: string,
  ): Promise<InvoiceDto> {
    const user = extractUser(req);
    return this.invoiceService.createInvoiceForOrder(orderId, user.id);
  }
}
