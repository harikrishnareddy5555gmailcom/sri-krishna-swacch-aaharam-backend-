import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { type InvoiceDto, InvoiceStatus } from '@vishkaraa/types';

function formatCurrency(paise: number, currency: string = 'INR'): string {
  const amount = (paise / 100).toFixed(2);
  const symbol = currency === 'INR' ? 'Rs.' : currency;
  return `${symbol} ${amount}`;
}

function formatDate(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return isoString;
  }
}

/**
 * Invoice Document Service — Phase 12F
 *
 * Provider-independent document generation boundary for PDF invoices.
 * Sourced strictly from immutable InvoiceDto snapshots without live catalog/user lookups.
 */
@Injectable()
export class InvoiceDocumentService {
  private readonly logger = new Logger(InvoiceDocumentService.name);

  /**
   * Generates a binary PDF buffer for the provided authoritative invoice snapshot.
   */
  async generatePdf(invoice: InvoiceDto): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margin: 40,
          info: {
            Title: `Invoice ${invoice.invoiceNumber}`,
            Author: 'Vishkaraa Naturals Private Limited',
            Subject: `Tax Invoice ${invoice.invoiceNumber}`,
            Creator: 'Vishkaraa Billing Engine',
          },
        });

        const buffers: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', (err) => {
          this.logger.error(`PDF generation error: ${err.message}`, err.stack);
          reject(err);
        });

        const pageWidth = 595.28; // Standard A4 width in pt
        const pageHeight = 841.89; // Standard A4 height in pt
        const margin = 40;
        const contentWidth = pageWidth - margin * 2;

        const isCancelled = invoice.status === InvoiceStatus.CANCELLED;

        // ─── CANCELLED Watermark ─────────────────────────────────────────────
        if (isCancelled) {
          doc.save();
          doc.fillColor('#fee2e2');
          doc.fontSize(60);
          doc.opacity(0.35);
          doc.rotate(-45, { origin: [pageWidth / 2, pageHeight / 2] });
          doc.text('CANCELLED', pageWidth / 2 - 180, pageHeight / 2 - 30);
          doc.restore();
        }

        // ─── Header: Branding & Document Metadata ────────────────────────────
        let y = margin;

        // Brand Name
        doc.font('Helvetica-Bold').fontSize(20).fillColor('#059669');
        doc.text('VISHKARAA NATURALS', margin, y);

        // Document Type on right
        doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827');
        doc.text(invoice.invoiceType || 'TAX INVOICE', margin, y, {
          align: 'right',
          width: contentWidth,
        });

        y += 24;

        // Subtitle
        doc.font('Helvetica').fontSize(9).fillColor('#6b7280');
        doc.text('Pure Ayurvedic Living • Quality & Authenticity', margin, y);

        // Invoice Number on right
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827');
        doc.text(`Invoice #: ${invoice.invoiceNumber}`, margin, y, {
          align: 'right',
          width: contentWidth,
        });

        y += 15;

        // Date on right
        doc.font('Helvetica').fontSize(9).fillColor('#4b5563');
        doc.text(`Issue Date: ${formatDate(invoice.issuedAt)}`, margin, y, {
          align: 'right',
          width: contentWidth,
        });

        y += 14;

        // Status on right
        const statusColor = isCancelled ? '#dc2626' : '#059669';
        doc.font('Helvetica-Bold').fontSize(9).fillColor(statusColor);
        doc.text(`Status: ${invoice.status}`, margin, y, {
          align: 'right',
          width: contentWidth,
        });

        y += 20;

        // ─── Cancelled Notice Banner ─────────────────────────────────────────
        if (isCancelled) {
          doc.rect(margin, y, contentWidth, 26).fillAndStroke('#fff1f2', '#fecdd3');
          doc.font('Helvetica-Bold').fontSize(9).fillColor('#9f1239');
          const cancelText = `DOCUMENT VOID: Cancelled on ${formatDate(invoice.cancelledAt)}${
            invoice.cancelReason ? ` — Reason: ${invoice.cancelReason}` : ''
          }`;
          doc.text(cancelText, margin + 8, y + 8, { width: contentWidth - 16 });
          y += 34;
        }

        // Horizontal divider
        doc.moveTo(margin, y).lineTo(pageWidth - margin, y).strokeColor('#e5e7eb').lineWidth(1).stroke();
        y += 12;

        // ─── Two-Column Info Cards (Seller & Buyer / Order) ───────────────────
        const colWidth = (contentWidth - 16) / 2;
        const col1X = margin;
        const col2X = margin + colWidth + 16;
        const cardY = y;

        // Column 1: Seller Details
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#4b5563');
        doc.text('SOLD BY (SELLER):', col1X, cardY);

        doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827');
        doc.text(invoice.sellerName, col1X, cardY + 12);

        doc.font('Helvetica').fontSize(8.5).fillColor('#4b5563');
        const sellerAddressParts = [
          invoice.sellerAddressLine1,
          invoice.sellerAddressLine2,
          [invoice.sellerCity, invoice.sellerState, invoice.sellerPostalCode].filter(Boolean).join(', '),
          invoice.sellerCountry,
        ].filter(Boolean);

        let sellerTextY = cardY + 25;
        for (const line of sellerAddressParts) {
          if (line) {
            doc.text(line, col1X, sellerTextY);
            sellerTextY += 11;
          }
        }

        if (invoice.sellerGstin) {
          doc.font('Helvetica-Bold').text(`GSTIN: ${invoice.sellerGstin}`, col1X, sellerTextY);
          sellerTextY += 11;
        }

        if (invoice.sellerEmail || invoice.sellerPhone) {
          const contact = [invoice.sellerEmail, invoice.sellerPhone].filter(Boolean).join(' • ');
          doc.font('Helvetica').text(contact, col1X, sellerTextY);
          sellerTextY += 11;
        }

        // Column 2: Buyer & Order Reference
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#4b5563');
        doc.text('BILLED TO (CUSTOMER):', col2X, cardY);

        doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827');
        doc.text(invoice.billingName || 'Valued Customer', col2X, cardY + 12);

        doc.font('Helvetica').fontSize(8.5).fillColor('#4b5563');
        const buyerAddressParts = [
          invoice.billingLine1,
          invoice.billingLine2,
          [invoice.billingCity, invoice.billingState, invoice.billingPostalCode].filter(Boolean).join(', '),
          invoice.billingCountry,
        ].filter(Boolean);

        let buyerTextY = cardY + 25;
        for (const line of buyerAddressParts) {
          if (line) {
            doc.text(line, col2X, buyerTextY);
            buyerTextY += 11;
          }
        }

        if (invoice.billingPhone) {
          doc.text(`Phone: ${invoice.billingPhone}`, col2X, buyerTextY);
          buyerTextY += 11;
        }

        if (invoice.customerGstin) {
          doc.font('Helvetica-Bold').text(`Customer GSTIN: ${invoice.customerGstin}`, col2X, buyerTextY);
          buyerTextY += 11;
        }

        // Order Reference metadata
        buyerTextY += 4;
        doc.font('Helvetica-Bold').text(`Order Reference: ${invoice.orderNumber || invoice.orderId}`, col2X, buyerTextY);
        buyerTextY += 11;

        if (invoice.placeOfSupply) {
          doc.font('Helvetica').text(`Place of Supply: ${invoice.placeOfSupply}`, col2X, buyerTextY);
          buyerTextY += 11;
        }

        y = Math.max(sellerTextY, buyerTextY) + 16;

        // ─── Items Table ─────────────────────────────────────────────────────
        // Table Header
        const colDescW = 215;
        const colSkuW = 80;
        const colQtyW = 30;
        const colPriceW = 60;
        const colDiscW = 55;
        const colTotalW = 75;

        doc.rect(margin, y, contentWidth, 20).fill('#f9fafb');
        doc.strokeColor('#e5e7eb').lineWidth(0.5).rect(margin, y, contentWidth, 20).stroke();

        doc.font('Helvetica-Bold').fontSize(8).fillColor('#374151');
        let colX = margin + 6;
        doc.text('Item Description', colX, y + 6, { width: colDescW });
        colX += colDescW;
        doc.text('SKU', colX, y + 6, { width: colSkuW });
        colX += colSkuW;
        doc.text('Qty', colX, y + 6, { width: colQtyW, align: 'center' });
        colX += colQtyW;
        doc.text('Unit Price', colX, y + 6, { width: colPriceW, align: 'right' });
        colX += colPriceW;
        doc.text('Discount', colX, y + 6, { width: colDiscW, align: 'right' });
        colX += colDiscW;
        doc.text('Line Total', colX, y + 6, { width: colTotalW, align: 'right' });

        y += 20;

        // Table Rows
        const items = invoice.items || [];
        if (items.length === 0) {
          doc.rect(margin, y, contentWidth, 24).strokeColor('#e5e7eb').stroke();
          doc.font('Helvetica').fontSize(8.5).fillColor('#6b7280');
          doc.text('No itemized records available in this invoice snapshot.', margin + 8, y + 8);
          y += 24;
        } else {
          for (const item of items) {
            const rowHeight = item.variantName ? 26 : 20;

            doc.rect(margin, y, contentWidth, rowHeight).strokeColor('#f3f4f6').lineWidth(0.5).stroke();

            // Description + Variant
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111827');
            doc.text(item.productName, margin + 6, y + 4, {
              width: colDescW - 10,
              lineBreak: false,
              ellipsis: true,
            });

            if (item.variantName) {
              doc.font('Helvetica').fontSize(7.5).fillColor('#6b7280');
              doc.text(`Variant: ${item.variantName}`, margin + 6, y + 14, {
                width: colDescW - 10,
                lineBreak: false,
                ellipsis: true,
              });
            }

            // SKU
            doc.font('Helvetica').fontSize(7.5).fillColor('#6b7280');
            doc.text(item.productSku || '—', margin + 6 + colDescW, y + 5, {
              width: colSkuW - 8,
              lineBreak: false,
              ellipsis: true,
            });

            // Qty
            doc.font('Helvetica').fontSize(8.5).fillColor('#111827');
            doc.text(String(item.quantity), margin + 6 + colDescW + colSkuW, y + 5, {
              width: colQtyW,
              align: 'center',
            });

            // Unit Price
            doc.text(
              formatCurrency(item.unitPrice, item.currency || invoice.currency),
              margin + colDescW + colSkuW + colQtyW,
              y + 5,
              { width: colPriceW, align: 'right' },
            );

            // Discount
            doc.font('Helvetica').fontSize(8.5).fillColor('#059669');
            const discText = item.discountAmount > 0
              ? `-${formatCurrency(item.discountAmount, item.currency || invoice.currency)}`
              : '—';
            doc.text(discText, margin + colDescW + colSkuW + colQtyW + colPriceW, y + 5, {
              width: colDiscW,
              align: 'right',
            });

            // Line Total
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111827');
            doc.text(
              formatCurrency(item.lineTotal, item.currency || invoice.currency),
              margin + colDescW + colSkuW + colQtyW + colPriceW + colDiscW,
              y + 5,
              { width: colTotalW, align: 'right' },
            );

            y += rowHeight;
          }
        }

        y += 12;

        // ─── Financial Totals Summary ─────────────────────────────────────────
        const totalsBlockW = 200;
        const totalsX = pageWidth - margin - totalsBlockW;

        doc.font('Helvetica').fontSize(8.5).fillColor('#4b5563');
        doc.text('Subtotal:', totalsX, y, { width: 90 });
        doc.text(formatCurrency(invoice.subtotal, invoice.currency), totalsX + 90, y, {
          width: totalsBlockW - 90,
          align: 'right',
        });
        y += 13;

        if (invoice.discountTotal > 0) {
          doc.fillColor('#059669');
          doc.text('Discount:', totalsX, y, { width: 90 });
          doc.text(`-${formatCurrency(invoice.discountTotal, invoice.currency)}`, totalsX + 90, y, {
            width: totalsBlockW - 90,
            align: 'right',
          });
          y += 13;
        }

        doc.fillColor('#4b5563');
        doc.text('Shipping:', totalsX, y, { width: 90 });
        doc.text(formatCurrency(invoice.shippingTotal, invoice.currency), totalsX + 90, y, {
          width: totalsBlockW - 90,
          align: 'right',
        });
        y += 13;

        doc.text('Tax:', totalsX, y, { width: 90 });
        doc.text(formatCurrency(invoice.taxTotal, invoice.currency), totalsX + 90, y, {
          width: totalsBlockW - 90,
          align: 'right',
        });
        y += 15;

        // Grand Total Box
        doc.rect(totalsX - 4, y - 2, totalsBlockW + 4, 20).fillAndStroke('#f0fdf4', '#86efac');
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#065f46');
        doc.text('Grand Total:', totalsX + 4, y + 4, { width: 85 });
        doc.text(formatCurrency(invoice.grandTotal, invoice.currency), totalsX + 90, y + 4, {
          width: totalsBlockW - 94,
          align: 'right',
        });

        // ─── Footer: Declaration & Support ────────────────────────────────────
        const footerY = pageHeight - margin - 35;
        doc.moveTo(margin, footerY).lineTo(pageWidth - margin, footerY).strokeColor('#e5e7eb').lineWidth(0.5).stroke();

        doc.font('Helvetica').fontSize(7.5).fillColor('#9ca3af');
        doc.text(
          'This is a computer-generated tax invoice and requires no physical signature. Preserved as an immutable accounting record.',
          margin,
          footerY + 8,
          { align: 'center', width: contentWidth },
        );
        doc.text(
          'Vishkaraa Naturals Private Limited • Registered in India • Support: care@vishkaraa.com',
          margin,
          footerY + 18,
          { align: 'center', width: contentWidth },
        );

        doc.end();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error(`Error constructing invoice PDF: ${error.message}`);
        reject(error);
      }
    });
  }
}
