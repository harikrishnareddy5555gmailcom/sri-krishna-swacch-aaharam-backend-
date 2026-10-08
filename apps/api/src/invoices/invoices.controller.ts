import {
  Controller,
  Get,
  Param,
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
import type { InvoiceDto, UserRole } from '@vishkaraa/types';
import type { MinimalUser } from '../permissions/permissions.service.js';

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
 * Customer Invoices Controller — Phase 12
 *
 * All routes require authentication. Invoices are strictly scoped to the
 * authenticated user (ownership guard prevents IDOR access).
 */
@Controller('invoices')
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(
    private readonly invoiceService: InvoiceService,
    private readonly invoiceDocumentService: InvoiceDocumentService,
  ) {}

  /**
   * GET /invoices/:id
   * Retrieve invoice by ID.
   */
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async getInvoiceById(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<InvoiceDto> {
    const user = extractUser(req);
    return this.invoiceService.getInvoiceById(id, user);
  }

  /**
   * GET /invoices/:id/pdf
   * Download or stream authoritative PDF representation of the invoice snapshot.
   */
  @Get(':id/pdf')
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
   * GET /invoices/by-order/:orderId
   * Retrieve invoice by order ID.
   */
  @Get('by-order/:orderId')
  @HttpCode(HttpStatus.OK)
  async getInvoiceByOrderId(
    @Req() req: Request,
    @Param('orderId') orderId: string,
  ): Promise<InvoiceDto> {
    const user = extractUser(req);
    return this.invoiceService.getInvoiceByOrderId(orderId, user);
  }
}
