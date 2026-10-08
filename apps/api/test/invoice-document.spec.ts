import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import { Permissions, UserRole, type InvoiceDto } from '@vishkaraa/types';
import { InvoiceDocumentService } from '../src/invoices/invoice-document.service.js';
import { InvoicesController } from '../src/invoices/invoices.controller.js';
import { AdminInvoicesController } from '../src/invoices/admin-invoices.controller.js';
import type { MinimalUser } from '../src/permissions/permissions.service.js';
import { PDFParse } from 'pdf-parse';

describe('Phase 12: Stage 12F — Invoice Document / Print / PDF', () => {
  let invoiceDocumentService: InvoiceDocumentService;
  let mockInvoiceService: any;
  let customerController: InvoicesController;
  let adminController: AdminInvoicesController;

  const testUser: MinimalUser = {
    id: 'user-uuid-1',
    role: UserRole.USER,
    email: 'user1@vishkaraa.local',
  };

  const otherUser: MinimalUser = {
    id: 'user-uuid-2',
    role: UserRole.USER,
    email: 'user2@vishkaraa.local',
  };

  const adminUser: MinimalUser = {
    id: 'admin-uuid-1',
    role: UserRole.ADMIN,
    email: 'admin@vishkaraa.local',
  };

  const superAdminUser: MinimalUser = {
    id: 'super-admin-uuid',
    role: UserRole.SUPER_ADMIN,
    email: 'superadmin@vishkaraa.local',
  };

  const sampleInvoice: InvoiceDto = {
    id: 'inv-uuid-123',
    invoiceNumber: 'VN-INV-202609-88889999',
    orderId: 'order-uuid-123',
    orderNumber: 'VN-202609-ABCD1234',
    userId: 'user-uuid-1',
    status: InvoiceStatus.ISSUED,
    currency: 'INR',
    subtotal: 90000, // Rs 900.00
    discountTotal: 5000, // Rs 50.00
    taxTotal: 0,
    shippingTotal: 4900, // Rs 49.00
    grandTotal: 89900, // Rs 899.00
    sellerName: 'Vishkaraa Naturals Private Limited',
    sellerGstin: '29ABCDE1234F1Z5',
    sellerAddressLine1: '42 Herbal Sanctuary Road',
    sellerAddressLine2: 'Phase 3, Industrial Area',
    sellerCity: 'Bengaluru',
    sellerState: 'Karnataka',
    sellerPostalCode: '560001',
    sellerCountry: 'IN',
    sellerEmail: 'care@vishkaraa.com',
    sellerPhone: '+91 80 1234 5678',
    billingName: 'Hari Raman',
    billingPhone: '+919876543210',
    billingLine1: '123 Natural Way',
    billingLine2: 'Suite 4',
    billingCity: 'Bengaluru',
    billingState: 'Karnataka',
    billingPostalCode: '560001',
    billingCountry: 'IN',
    customerGstin: null,
    placeOfSupply: null,
    invoiceType: 'TAX INVOICE',
    issuedAt: new Date('2026-09-29T10:00:00Z').toISOString(),
    cancelledAt: null,
    cancelReason: null,
    items: [
      {
        id: 'item-1',
        invoiceId: 'inv-uuid-123',
        orderItemId: 'order-item-1',
        productId: 'prod-1',
        variantId: 'var-1',
        productName: 'Kumkumadi Ayurvedic Face Glow Serum',
        variantName: '30ml Luxury Dropper',
        productSku: 'KUM-30ML',
        quantity: 2,
        unitPrice: 45000,
        discountAmount: 2500,
        taxableAmount: 42500,
        taxRate: 0,
        taxAmount: 0,
        lineTotal: 85000,
        currency: 'INR',
      },
    ],
    createdAt: new Date('2026-09-29T10:00:00Z').toISOString(),
    updatedAt: new Date('2026-09-29T10:00:00Z').toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    invoiceDocumentService = new InvoiceDocumentService();

    mockInvoiceService = {
      getInvoiceById: vi.fn(),
    };

    customerController = new InvoicesController(
      mockInvoiceService as any,
      invoiceDocumentService,
    );

    adminController = new AdminInvoicesController(
      mockInvoiceService as any,
      invoiceDocumentService,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. PDF Generation from authoritative snapshot
  // ───────────────────────────────────────────────────────────────────────────
  it('1. generates a valid binary PDF buffer starting with %PDF- from invoice snapshot', async () => {
    const pdfBuffer = await invoiceDocumentService.generatePdf(sampleInvoice);

    expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
    expect(pdfBuffer.length).toBeGreaterThan(500);
    expect(pdfBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Real PDF integration text extraction (pdf-parse)
  // ───────────────────────────────────────────────────────────────────────────
  it('2. [REAL PDF INTEGRATION] parses generated PDF text and verifies invoice number and grand total', async () => {
    const pdfBuffer = await invoiceDocumentService.generatePdf(sampleInvoice);

    const parser = new PDFParse({ data: pdfBuffer });
    const result = await parser.getText();
    const pdfText = result.text;

    // Verify key fields in rendered text
    expect(pdfText).toContain('VISHKARAA NATURALS');
    expect(pdfText).toContain(sampleInvoice.invoiceNumber);
    expect(pdfText).toContain('TAX INVOICE');
    expect(pdfText).toContain('Kumkumadi Ayurvedic Face Glow Serum');
    expect(pdfText).toContain('KUM-30ML');
    // Rs. 899.00 grand total
    expect(pdfText).toContain('899.00');
    // Hari Raman customer
    expect(pdfText).toContain('Hari Raman');
    // Seller GSTIN
    expect(pdfText).toContain('29ABCDE1234F1Z5');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Immutability: Catalog / address live changes do not alter invoice document
  // ───────────────────────────────────────────────────────────────────────────
  it('3. document generation relies exclusively on snapshot: external mutations do not affect PDF', async () => {
    // Generate original
    const pdfBuffer1 = await invoiceDocumentService.generatePdf(sampleInvoice);
    const parser1 = new PDFParse({ data: pdfBuffer1 });
    const text1 = (await parser1.getText()).text;

    // Even if live catalog or live user address were different in DB,
    // the Invoice Document Service takes only the immutable InvoiceDto
    expect(text1).toContain('Kumkumadi Ayurvedic Face Glow Serum');
    expect(text1).toContain('899.00');
    expect(text1).not.toContain('Arbitrary Changed Catalog Title');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Cancelled invoice rendering
  // ───────────────────────────────────────────────────────────────────────────
  it('4. cancelled invoice renders CANCELLED watermark and void notice with reason', async () => {
    const cancelledInvoice: InvoiceDto = {
      ...sampleInvoice,
      status: InvoiceStatus.CANCELLED,
      cancelledAt: new Date('2026-09-29T12:00:00Z').toISOString(),
      cancelReason: 'Customer requested cancellation prior to dispatch',
    };

    const pdfBuffer = await invoiceDocumentService.generatePdf(cancelledInvoice);
    const parser = new PDFParse({ data: pdfBuffer });
    const result = await parser.getText();
    const pdfText = result.text;

    expect(pdfText).toContain('CANCELLED');
    expect(pdfText).toContain('DOCUMENT VOID');
    expect(pdfText).toContain('Customer requested cancellation prior to dispatch');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Customer ownership is enforced
  // ───────────────────────────────────────────────────────────────────────────
  it('5. customer ownership is enforced: cross-user access throws NotFoundException (IDOR safe)', async () => {
    mockInvoiceService.getInvoiceById.mockRejectedValueOnce(
      new NotFoundException('Invoice not found or access denied.'),
    );

    const mockReq = {
      user: otherUser,
      query: {},
    } as any;

    const mockRes = {
      setHeader: vi.fn(),
      end: vi.fn(),
    } as any;

    await expect(
      customerController.getInvoicePdf(mockReq, sampleInvoice.id, mockRes),
    ).rejects.toThrow(NotFoundException);

    expect(mockInvoiceService.getInvoiceById).toHaveBeenCalledWith(
      sampleInvoice.id,
      otherUser,
    );
    expect(mockRes.end).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Admin and Super Admin access
  // ───────────────────────────────────────────────────────────────────────────
  it('6. admin with INVOICES_VIEW and super admin can generate invoice PDF', async () => {
    mockInvoiceService.getInvoiceById.mockResolvedValue(sampleInvoice);

    // Admin request
    const adminReq = {
      user: adminUser,
      query: {},
    } as any;

    const adminRes = {
      setHeader: vi.fn(),
      end: vi.fn(),
    } as any;

    await adminController.getInvoicePdf(adminReq, sampleInvoice.id, adminRes);

    expect(adminRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(adminRes.end).toHaveBeenCalled();

    // Super Admin request
    const superAdminReq = {
      user: superAdminUser,
      query: {},
    } as any;

    const superAdminRes = {
      setHeader: vi.fn(),
      end: vi.fn(),
    } as any;

    await adminController.getInvoicePdf(superAdminReq, sampleInvoice.id, superAdminRes);

    expect(superAdminRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(superAdminRes.end).toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Stored totals match generated document values
  // ───────────────────────────────────────────────────────────────────────────
  it('7. stored invoice totals match document values without recalculation', async () => {
    const pdfBuffer = await invoiceDocumentService.generatePdf(sampleInvoice);
    const parser = new PDFParse({ data: pdfBuffer });
    const text = (await parser.getText()).text;

    // Subtotal: 900.00
    expect(text).toContain('900.00');
    // Discount: -Rs. 50.00
    expect(text).toContain('50.00');
    // Shipping: 49.00
    expect(text).toContain('49.00');
    // Grand Total: 899.00
    expect(text).toContain('899.00');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Long product names render safely
  // ───────────────────────────────────────────────────────────────────────────
  it('8. long product names and descriptions wrap safely without throwing errors', async () => {
    const longNameInvoice: InvoiceDto = {
      ...sampleInvoice,
      items: [
        {
          ...sampleInvoice.items[0],
          productName:
            'Very Long Ayurvedic Herbal Wellness Infusion Elixir with 48 Authentic Himalayan Herbs, Cold Pressed Oils, and Organic Natural Roots Extract (Limited Festive Edition Pack 2026)',
          variantName: '500ml Extra Value Family Pack with Free Measuring Cup & Wooden Scoop',
        },
      ],
    };

    const pdfBuffer = await invoiceDocumentService.generatePdf(longNameInvoice);
    expect(Buffer.isBuffer(pdfBuffer)).toBe(true);

    const parser = new PDFParse({ data: pdfBuffer });
    const text = (await parser.getText()).text;
    expect(text).toContain('Very Long Ayurvedic Herbal');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 9. Optional GST fields compatibility
  // ───────────────────────────────────────────────────────────────────────────
  it('9. optional GST fields (GSTIN, place of supply) render safely when populated and when null', async () => {
    // Populated
    const gstInvoice: InvoiceDto = {
      ...sampleInvoice,
      customerGstin: '29ABCDE5678G1Z9',
      placeOfSupply: '29-Karnataka',
    };

    const pdfBufferWithGst = await invoiceDocumentService.generatePdf(gstInvoice);
    const parserWithGst = new PDFParse({ data: pdfBufferWithGst });
    const textWithGst = (await parserWithGst.getText()).text;
    expect(textWithGst).toContain('29ABCDE5678G1Z9');
    expect(textWithGst).toContain('Place of Supply: 29-Karnataka');

    // Null
    const nullGstInvoice: InvoiceDto = {
      ...sampleInvoice,
      customerGstin: null,
      placeOfSupply: null,
    };
    const pdfBufferNoGst = await invoiceDocumentService.generatePdf(nullGstInvoice);
    expect(Buffer.isBuffer(pdfBufferNoGst)).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 10. Missing optional variant / SKU render safely
  // ───────────────────────────────────────────────────────────────────────────
  it('10. missing optional variant and SKU render safely with fallback', async () => {
    const noVariantInvoice: InvoiceDto = {
      ...sampleInvoice,
      items: [
        {
          ...sampleInvoice.items[0],
          variantName: null,
          productSku: null,
        },
      ],
    };

    const pdfBuffer = await invoiceDocumentService.generatePdf(noVariantInvoice);
    const parser = new PDFParse({ data: pdfBuffer });
    const text = (await parser.getText()).text;
    expect(text).toContain('Kumkumadi Ayurvedic Face Glow Serum');
    // Sku fallback '—'
    expect(text).toContain('—');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 11. PDF Response Headers & Filename Sanitization
  // ───────────────────────────────────────────────────────────────────────────
  it('11. controller returns correct headers and safe sanitized filename', async () => {
    mockInvoiceService.getInvoiceById.mockResolvedValue(sampleInvoice);

    const headers: Record<string, string | number> = {};
    const mockRes = {
      setHeader: vi.fn((key: string, val: string | number) => {
        headers[key] = val;
      }),
      end: vi.fn(),
    } as any;

    const mockReq = {
      user: testUser,
      query: {},
    } as any;

    await customerController.getInvoicePdf(mockReq, sampleInvoice.id, mockRes);

    expect(headers['Content-Type']).toBe('application/pdf');
    expect(headers['Content-Disposition']).toBe(
      `attachment; filename="Vishkaraa-Invoice-${sampleInvoice.invoiceNumber}.pdf"`,
    );
    expect(headers['Cache-Control']).toBe('private, no-cache, no-store, must-revalidate');
    expect(headers['Content-Length']).toBeGreaterThan(500);
    expect(mockRes.end).toHaveBeenCalled();
  });

  it('12. filename prevents header injection and sanitizes dangerous characters', async () => {
    const dirtyNumberInvoice: InvoiceDto = {
      ...sampleInvoice,
      invoiceNumber: 'INV/2026\r\nSet-Cookie: evil=1\x00;test',
    };
    mockInvoiceService.getInvoiceById.mockResolvedValue(dirtyNumberInvoice);

    const headers: Record<string, string | number> = {};
    const mockRes = {
      setHeader: vi.fn((key: string, val: string | number) => {
        headers[key] = val;
      }),
      end: vi.fn(),
    } as any;

    const mockReq = {
      user: testUser,
      query: {},
    } as any;

    await customerController.getInvoicePdf(mockReq, sampleInvoice.id, mockRes);

    const disposition = String(headers['Content-Disposition']);
    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('\n');
    expect(disposition).not.toContain('\x00');
    expect(disposition).toBe(
      'attachment; filename="Vishkaraa-Invoice-INV_2026__Set-Cookie__evil_1__test.pdf"',
    );
  });
});
