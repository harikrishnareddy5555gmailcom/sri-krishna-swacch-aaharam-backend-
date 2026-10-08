import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import type {
  TrialBalanceReport,
  ProfitLossReport,
  BalanceSheetReport,
  AccountDrillDownReport,
} from './dto/finance-reports.dto.js';

/**
 * Escapes and sanitizes a CSV cell to prevent formula injection (=, +, -, @, \t, \r)
 * and properly quote cells containing commas, quotes, and newlines.
 */
export function escapeCsvCell(val: string | number | boolean | null | undefined): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number' || typeof val === 'boolean') {
    return String(val);
  }
  let str = val;
  // Protect against CSV formula injection for string values starting with =, +, -, @, \t, \r
  // while preserving standard signed numeric strings
  if (/^[=+\-@\t\r]/.test(str) && !/^[+-]?\d+(\.\d+)?$/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    str = `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function formatPaiseToInr(paise: number): string {
  const isNegative = paise < 0;
  const abs = Math.abs(paise);
  const formatted = (abs / 100).toFixed(2);
  return `${isNegative ? '-' : ''}${formatted}`;
}

export function formatCurrencyDisplay(paise: number): string {
  const isNegative = paise < 0;
  const abs = Math.abs(paise);
  const formatted = (abs / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${isNegative ? '-' : ''}Rs. ${formatted}`;
}

function formatDate(isoString?: string | null): string {
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
 * Finance Export Service — Phase 16B
 *
 * Operational CSV and PDF export generator for financial reports.
 * Consumes strictly authoritative Report DTOs produced by FinanceService.
 * Does NOT recalculate or re-query financial transactions independently.
 */
@Injectable()
export class FinanceExportService {
  private readonly logger = new Logger(FinanceExportService.name);

  // ===========================================================================
  // CSV EXPORT GENERATORS
  // ===========================================================================

  /**
   * Generates CSV for Trial Balance.
   */
  generateTrialBalanceCsv(report: TrialBalanceReport): string {
    const rows: string[][] = [];

    // Metadata header
    rows.push(['Report', 'Trial Balance']);
    rows.push([
      'Reporting Period',
      `${report.period.startDate ?? 'Epoch'} to ${report.period.endDate ?? 'Present'} (${report.period.preset ?? 'CUSTOM'})`,
    ]);
    rows.push(['As Of Date', report.asOf]);
    rows.push(['Generated At', new Date().toISOString()]);
    rows.push(['Status', report.isBalanced ? 'BALANCED' : 'UNBALANCED']);
    rows.push([]);

    // Table Column Headers
    rows.push([
      'Account Code',
      'Account Name',
      'Account Type',
      'Normal Balance',
      'Debit (Paise)',
      'Debit (INR)',
      'Credit (Paise)',
      'Credit (INR)',
      'Net Balance (Paise)',
      'Net Balance (INR)',
    ]);

    // Data Rows
    for (const item of report.accounts) {
      rows.push([
        item.account.code,
        item.account.name,
        item.account.type,
        item.account.normalBalance,
        String(item.totalDebitPaise),
        formatPaiseToInr(item.totalDebitPaise),
        String(item.totalCreditPaise),
        formatPaiseToInr(item.totalCreditPaise),
        String(item.balancePaise),
        formatPaiseToInr(item.balancePaise),
      ]);
    }

    // Totals / Invariant Verification Row
    const diffPaise = report.totalDebitPaise - report.totalCreditPaise;
    rows.push([]);
    rows.push([
      'TOTALS',
      '',
      '',
      '',
      String(report.totalDebitPaise),
      formatPaiseToInr(report.totalDebitPaise),
      String(report.totalCreditPaise),
      formatPaiseToInr(report.totalCreditPaise),
      String(diffPaise),
      formatPaiseToInr(diffPaise),
    ]);
    rows.push([
      'VERIFICATION',
      report.isBalanced
        ? 'BALANCED: Total Debits equal Total Credits'
        : `UNBALANCED: Difference of ${formatPaiseToInr(diffPaise)} INR`,
    ]);

    return rows.map((r) => r.map(escapeCsvCell).join(',')).join('\r\n');
  }

  /**
   * Generates CSV for Profit & Loss Statement.
   */
  generateProfitLossCsv(report: ProfitLossReport): string {
    const rows: string[][] = [];

    // Metadata header
    rows.push(['Report', 'Profit & Loss Statement']);
    rows.push([
      'Reporting Period',
      `${report.period.startDate} to ${report.period.endDate} (${report.period.preset ?? 'CUSTOM'})`,
    ]);
    rows.push(['Generated At', new Date().toISOString()]);
    rows.push(['Result', report.isProfitable ? 'PROFITABLE' : 'NET LOSS']);
    rows.push([]);

    // Section 1: REVENUE
    rows.push(['--- REVENUE ---']);
    rows.push([
      'Account Code',
      'Account Name',
      'Debit (Paise)',
      'Debit (INR)',
      'Credit (Paise)',
      'Credit (INR)',
      'Net Revenue (Paise)',
      'Net Revenue (INR)',
    ]);
    for (const item of report.revenue.accounts) {
      rows.push([
        item.account.code,
        item.account.name,
        String(item.totalDebitPaise),
        formatPaiseToInr(item.totalDebitPaise),
        String(item.totalCreditPaise),
        formatPaiseToInr(item.totalCreditPaise),
        String(item.balancePaise),
        formatPaiseToInr(item.balancePaise),
      ]);
    }
    rows.push([
      'TOTAL REVENUE',
      '',
      '',
      '',
      '',
      '',
      String(report.revenue.totalRevenuePaise),
      formatPaiseToInr(report.revenue.totalRevenuePaise),
    ]);
    rows.push([]);

    // Section 2: EXPENSES
    rows.push(['--- OPERATING EXPENSES ---']);
    rows.push([
      'Account Code',
      'Account Name',
      'Debit (Paise)',
      'Debit (INR)',
      'Credit (Paise)',
      'Credit (INR)',
      'Net Expense (Paise)',
      'Net Expense (INR)',
    ]);
    for (const item of report.expenses.accounts) {
      rows.push([
        item.account.code,
        item.account.name,
        String(item.totalDebitPaise),
        formatPaiseToInr(item.totalDebitPaise),
        String(item.totalCreditPaise),
        formatPaiseToInr(item.totalCreditPaise),
        String(item.balancePaise),
        formatPaiseToInr(item.balancePaise),
      ]);
    }
    rows.push([
      'TOTAL EXPENSES',
      '',
      '',
      '',
      '',
      '',
      String(report.expenses.totalExpensePaise),
      formatPaiseToInr(report.expenses.totalExpensePaise),
    ]);
    rows.push([]);

    // Summary Row
    rows.push([
      'NET INCOME',
      '',
      '',
      '',
      '',
      '',
      String(report.netIncomePaise),
      formatPaiseToInr(report.netIncomePaise),
    ]);
    rows.push(['PROFITABILITY STATUS', report.isProfitable ? 'NET PROFIT' : 'NET LOSS']);

    return rows.map((r) => r.map(escapeCsvCell).join(',')).join('\r\n');
  }

  /**
   * Generates CSV for Balance Sheet.
   */
  generateBalanceSheetCsv(report: BalanceSheetReport): string {
    const rows: string[][] = [];

    // Metadata header
    rows.push(['Report', 'Balance Sheet']);
    rows.push(['As Of Date', report.asOf]);
    rows.push([
      'Reporting Period',
      `${report.period.startDate ?? 'Epoch'} to ${report.period.endDate ?? 'Present'} (${report.period.preset ?? 'CUSTOM'})`,
    ]);
    rows.push(['Generated At', new Date().toISOString()]);
    rows.push(['Reconciliation Status', report.isBalanced ? 'BALANCED' : 'UNCLOSED EARNINGS']);
    rows.push([]);

    // Section 1: ASSETS
    rows.push(['--- ASSETS ---']);
    rows.push([
      'Account Code',
      'Account Name',
      'Debit (Paise)',
      'Debit (INR)',
      'Credit (Paise)',
      'Credit (INR)',
      'Net Balance (Paise)',
      'Net Balance (INR)',
    ]);
    for (const item of report.assets.accounts) {
      rows.push([
        item.account.code,
        item.account.name,
        String(item.totalDebitPaise),
        formatPaiseToInr(item.totalDebitPaise),
        String(item.totalCreditPaise),
        formatPaiseToInr(item.totalCreditPaise),
        String(item.balancePaise),
        formatPaiseToInr(item.balancePaise),
      ]);
    }
    rows.push([
      'TOTAL ASSETS',
      '',
      '',
      '',
      '',
      '',
      String(report.assets.totalAssetsPaise),
      formatPaiseToInr(report.assets.totalAssetsPaise),
    ]);
    rows.push([]);

    // Section 2: LIABILITIES
    rows.push(['--- LIABILITIES ---']);
    rows.push([
      'Account Code',
      'Account Name',
      'Debit (Paise)',
      'Debit (INR)',
      'Credit (Paise)',
      'Credit (INR)',
      'Net Balance (Paise)',
      'Net Balance (INR)',
    ]);
    for (const item of report.liabilities.accounts) {
      rows.push([
        item.account.code,
        item.account.name,
        String(item.totalDebitPaise),
        formatPaiseToInr(item.totalDebitPaise),
        String(item.totalCreditPaise),
        formatPaiseToInr(item.totalCreditPaise),
        String(item.balancePaise),
        formatPaiseToInr(item.balancePaise),
      ]);
    }
    rows.push([
      'TOTAL LIABILITIES',
      '',
      '',
      '',
      '',
      '',
      String(report.liabilities.totalLiabilitiesPaise),
      formatPaiseToInr(report.liabilities.totalLiabilitiesPaise),
    ]);
    rows.push([]);

    // Section 3: EQUITY
    rows.push(['--- EQUITY ---']);
    rows.push([
      'Account Code',
      'Account Name',
      'Debit (Paise)',
      'Debit (INR)',
      'Credit (Paise)',
      'Credit (INR)',
      'Net Balance (Paise)',
      'Net Balance (INR)',
    ]);
    for (const item of report.equity.accounts) {
      rows.push([
        item.account.code,
        item.account.name,
        String(item.totalDebitPaise),
        formatPaiseToInr(item.totalDebitPaise),
        String(item.totalCreditPaise),
        formatPaiseToInr(item.totalCreditPaise),
        String(item.balancePaise),
        formatPaiseToInr(item.balancePaise),
      ]);
    }
    rows.push([
      'TOTAL EQUITY',
      '',
      '',
      '',
      '',
      '',
      String(report.equity.totalEquityPaise),
      formatPaiseToInr(report.equity.totalEquityPaise),
    ]);
    rows.push([]);

    // Summary & Accounting Reconciliation
    rows.push([
      'TOTAL LIABILITIES + EQUITY',
      '',
      '',
      '',
      '',
      '',
      String(report.totalLiabilitiesAndEquityPaise),
      formatPaiseToInr(report.totalLiabilitiesAndEquityPaise),
    ]);
    rows.push([
      'BALANCE DIFFERENCE',
      '',
      '',
      '',
      '',
      '',
      String(report.balanceDifferencePaise),
      formatPaiseToInr(report.balanceDifferencePaise),
    ]);
    rows.push(['RECONCILIATION NOTE', report.reconciliationNote]);

    return rows.map((r) => r.map(escapeCsvCell).join(',')).join('\r\n');
  }

  /**
   * Generates CSV for Account Drill-Down.
   */
  generateAccountDrillDownCsv(report: AccountDrillDownReport): string {
    const rows: string[][] = [];

    // Header Metadata
    rows.push(['Account Drill-Down Report']);
    rows.push(['Account Code', report.account.code]);
    rows.push(['Account Name', report.account.name]);
    rows.push(['Account Type', report.account.type]);
    rows.push(['Normal Balance', report.account.normalBalance]);
    rows.push([
      'Reporting Period',
      `${report.period.startDate ?? 'Epoch'} to ${report.period.endDate ?? 'Present'}`,
    ]);
    rows.push(['Opening Balance (Paise)', String(report.openingBalancePaise)]);
    rows.push(['Opening Balance (INR)', formatPaiseToInr(report.openingBalancePaise)]);
    rows.push(['Period Total Debits (Paise)', String(report.periodDebitPaise)]);
    rows.push(['Period Total Debits (INR)', formatPaiseToInr(report.periodDebitPaise)]);
    rows.push(['Period Total Credits (Paise)', String(report.periodCreditPaise)]);
    rows.push(['Period Total Credits (INR)', formatPaiseToInr(report.periodCreditPaise)]);
    rows.push(['Closing Balance (Paise)', String(report.closingBalancePaise)]);
    rows.push(['Closing Balance (INR)', formatPaiseToInr(report.closingBalancePaise)]);
    rows.push(['Generated At', new Date().toISOString()]);
    rows.push([]);

    // Table Column Headers
    rows.push([
      'Line ID',
      'Transaction ID',
      'Transaction Type',
      'Source Type',
      'Source ID',
      'Description',
      'Posted At',
      'Debit (Paise)',
      'Debit (INR)',
      'Credit (Paise)',
      'Credit (INR)',
    ]);

    // Data Rows
    for (const entry of report.entries) {
      rows.push([
        entry.id,
        entry.transactionId,
        entry.transactionType,
        entry.sourceType ?? '',
        entry.sourceId ?? '',
        entry.description ?? '',
        entry.postedAt ?? '',
        String(entry.debitPaise),
        formatPaiseToInr(entry.debitPaise),
        String(entry.creditPaise),
        formatPaiseToInr(entry.creditPaise),
      ]);
    }

    // Summary Row
    rows.push([]);
    rows.push([
      'PERIOD TOTALS',
      '',
      '',
      '',
      '',
      '',
      '',
      String(report.periodDebitPaise),
      formatPaiseToInr(report.periodDebitPaise),
      String(report.periodCreditPaise),
      formatPaiseToInr(report.periodCreditPaise),
    ]);

    return rows.map((r) => r.map(escapeCsvCell).join(',')).join('\r\n');
  }

  // ===========================================================================
  // PDF EXPORT GENERATORS
  // ===========================================================================

  /**
   * Generates authoritative binary PDF buffer for Trial Balance.
   */
  async generateTrialBalancePdf(report: TrialBalanceReport): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margin: 40,
          info: {
            Title: 'Trial Balance Report',
            Author: 'Vishkaraa Naturals Private Limited',
            Subject: 'Authoritative Financial Statements',
            Creator: 'Vishkaraa Finance Reporting Engine',
          },
        });

        const buffers: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', (err) => {
          this.logger.error(`PDF generation error: ${err.message}`, err.stack);
          reject(err);
        });

        const pageWidth = 595.28;
        const pageHeight = 841.89;
        const margin = 40;
        const contentWidth = pageWidth - margin * 2;

        let y = margin;

        // Brand & Title
        doc.font('Helvetica-Bold').fontSize(18).fillColor('#059669');
        doc.text('VISHKARAA NATURALS', margin, y);
        doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827');
        doc.text('TRIAL BALANCE', margin, y, { align: 'right', width: contentWidth });
        y += 24;

        // Subtitle / Period
        doc.font('Helvetica').fontSize(9).fillColor('#6b7280');
        const periodText = `Period: ${report.period.startDate ? formatDate(report.period.startDate) : 'Epoch'} to ${report.period.endDate ? formatDate(report.period.endDate) : 'Present'} (${report.period.preset ?? 'CUSTOM'})`;
        doc.text(periodText, margin, y);
        doc.text(`Generated: ${formatDate(new Date().toISOString())}`, margin, y, {
          align: 'right',
          width: contentWidth,
        });
        y += 18;

        // Status Card
        const statusBg = report.isBalanced ? '#ecfdf5' : '#fef2f2';
        const statusBorder = report.isBalanced ? '#a7f3d0' : '#fecaca';
        const statusColor = report.isBalanced ? '#065f46' : '#991b1b';
        doc.rect(margin, y, contentWidth, 24).fillAndStroke(statusBg, statusBorder);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(statusColor);
        doc.text(
          report.isBalanced
            ? 'LEDGER BALANCED — Total Debits match Total Credits exactly'
            : 'LEDGER UNBALANCED — Difference detected between Total Debits and Credits',
          margin + 10,
          y + 7,
        );
        y += 34;

        // Table Column Specifications
        // Columns: Code (65), Name (150), Type (65), Debit (75), Credit (75), Balance (85) = 515
        const cols = [
          { name: 'Code', x: margin, w: 65, align: 'left' as const },
          { name: 'Account Name', x: margin + 65, w: 155, align: 'left' as const },
          { name: 'Type', x: margin + 220, w: 65, align: 'left' as const },
          { name: 'Debit (INR)', x: margin + 285, w: 75, align: 'right' as const },
          { name: 'Credit (INR)', x: margin + 360, w: 75, align: 'right' as const },
          { name: 'Balance (INR)', x: margin + 435, w: 80, align: 'right' as const },
        ];

        const drawTableHeader = () => {
          doc.rect(margin, y, contentWidth, 20).fill('#f3f4f6');
          doc.font('Helvetica-Bold').fontSize(8).fillColor('#374151');
          for (const col of cols) {
            doc.text(col.name, col.x + 4, y + 6, { width: col.w - 8, align: col.align });
          }
          y += 20;
        };

        drawTableHeader();

        const [cCode, cName, cType, cDebit, cCredit, cBalance] = cols;

        // Data Rows
        doc.font('Helvetica').fontSize(8).fillColor('#111827');
        let isAlt = false;

        for (const item of report.accounts) {
          if (y > pageHeight - 60) {
            doc.addPage();
            y = margin;
            drawTableHeader();
          }

          if (isAlt) {
            doc.rect(margin, y, contentWidth, 18).fill('#fafafa');
          }

          doc.fillColor('#111827');
          if (cCode) doc.text(item.account.code, cCode.x + 4, y + 5, { width: cCode.w - 8 });
          if (cName) {
            doc.text(item.account.name, cName.x + 4, y + 5, {
              width: cName.w - 8,
              lineBreak: false,
              ellipsis: true,
            });
          }
          if (cType) doc.text(item.account.type, cType.x + 4, y + 5, { width: cType.w - 8 });
          if (cDebit) {
            doc.text(formatCurrencyDisplay(item.totalDebitPaise), cDebit.x + 4, y + 5, {
              width: cDebit.w - 8,
              align: 'right',
            });
          }
          if (cCredit) {
            doc.text(formatCurrencyDisplay(item.totalCreditPaise), cCredit.x + 4, y + 5, {
              width: cCredit.w - 8,
              align: 'right',
            });
          }
          if (cBalance) {
            doc.text(formatCurrencyDisplay(item.balancePaise), cBalance.x + 4, y + 5, {
              width: cBalance.w - 8,
              align: 'right',
            });
          }

          // Row divider line
          doc.moveTo(margin, y + 18).lineTo(margin + contentWidth, y + 18).strokeColor('#f3f4f6').stroke();
          y += 18;
          isAlt = !isAlt;
        }

        // Summary Block
        if (y > pageHeight - 90) {
          doc.addPage();
          y = margin;
        }

        y += 8;
        doc.rect(margin, y, contentWidth, 24).fill('#e5e7eb');
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#111827');
        if (cCode) doc.text('TOTALS', cCode.x + 4, y + 8, { width: 150 });
        if (cDebit) {
          doc.text(formatCurrencyDisplay(report.totalDebitPaise), cDebit.x + 4, y + 8, {
            width: cDebit.w - 8,
            align: 'right',
          });
        }
        if (cCredit) {
          doc.text(formatCurrencyDisplay(report.totalCreditPaise), cCredit.x + 4, y + 8, {
            width: cCredit.w - 8,
            align: 'right',
          });
        }
        const diffPaise = report.totalDebitPaise - report.totalCreditPaise;
        if (cBalance) {
          doc.text(formatCurrencyDisplay(diffPaise), cBalance.x + 4, y + 8, {
            width: cBalance.w - 8,
            align: 'right',
          });
        }
        y += 32;

        // Footer / Sign-off
        doc.font('Helvetica').fontSize(8).fillColor('#9ca3af');
        doc.text(
          'Authoritative financial report generated from immutable double-entry ledger. All balances in INR.',
          margin,
          pageHeight - 30,
          { align: 'center', width: contentWidth },
        );

        doc.end();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Generates authoritative binary PDF buffer for Profit & Loss Statement.
   */
  async generateProfitLossPdf(report: ProfitLossReport): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margin: 40,
          info: {
            Title: 'Profit & Loss Statement',
            Author: 'Vishkaraa Naturals Private Limited',
            Subject: 'Authoritative Financial Statements',
            Creator: 'Vishkaraa Finance Reporting Engine',
          },
        });

        const buffers: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', (err) => {
          this.logger.error(`PDF generation error: ${err.message}`, err.stack);
          reject(err);
        });

        const pageWidth = 595.28;
        const pageHeight = 841.89;
        const margin = 40;
        const contentWidth = pageWidth - margin * 2;

        let y = margin;

        // Brand & Title
        doc.font('Helvetica-Bold').fontSize(18).fillColor('#059669');
        doc.text('VISHKARAA NATURALS', margin, y);
        doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827');
        doc.text('PROFIT & LOSS STATEMENT', margin, y, { align: 'right', width: contentWidth });
        y += 24;

        // Subtitle / Period
        doc.font('Helvetica').fontSize(9).fillColor('#6b7280');
        const periodText = `Period: ${formatDate(report.period.startDate)} to ${formatDate(report.period.endDate)} (${report.period.preset ?? 'CUSTOM'})`;
        doc.text(periodText, margin, y);
        doc.text(`Generated: ${formatDate(new Date().toISOString())}`, margin, y, {
          align: 'right',
          width: contentWidth,
        });
        y += 18;

        // Net Income Highlight Card
        const isProfitable = report.isProfitable;
        const cardBg = isProfitable ? '#ecfdf5' : '#fef2f2';
        const cardBorder = isProfitable ? '#a7f3d0' : '#fecaca';
        const cardColor = isProfitable ? '#065f46' : '#991b1b';
        doc.rect(margin, y, contentWidth, 32).fillAndStroke(cardBg, cardBorder);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(cardColor);
        doc.text(
          isProfitable ? 'NET PROFIT FOR PERIOD' : 'NET LOSS FOR PERIOD',
          margin + 12,
          y + 10,
        );
        doc.text(formatCurrencyDisplay(report.netIncomePaise), margin, y + 10, {
          align: 'right',
          width: contentWidth - 12,
        });
        y += 42;

        // Helper to render account sections
        const renderSection = (
          title: string,
          accounts: ProfitLossReport['revenue']['accounts'],
          totalPaise: number,
          isRevenue: boolean,
        ) => {
          if (y > pageHeight - 80) {
            doc.addPage();
            y = margin;
          }

          // Section Header
          doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827');
          doc.text(title, margin, y);
          y += 16;

          // Header Row
          doc.rect(margin, y, contentWidth, 18).fill('#f3f4f6');
          doc.font('Helvetica-Bold').fontSize(8).fillColor('#374151');
          doc.text('Code', margin + 6, y + 5, { width: 70 });
          doc.text('Account Name', margin + 80, y + 5, { width: 300 });
          doc.text('Amount (INR)', margin + 390, y + 5, { width: 120, align: 'right' });
          y += 18;

          doc.font('Helvetica').fontSize(8);
          if (accounts.length === 0) {
            doc.fillColor('#6b7280').text('No activity recorded in this period.', margin + 10, y + 5);
            y += 18;
          } else {
            for (const item of accounts) {
              if (y > pageHeight - 50) {
                doc.addPage();
                y = margin;
              }
              doc.text(item.account.code, margin + 6, y + 5, { width: 70 });
              doc.text(item.account.name, margin + 80, y + 5, { width: 300 });
              doc.text(formatCurrencyDisplay(item.balancePaise), margin + 390, y + 5, {
                width: 120,
                align: 'right',
              });
              doc.moveTo(margin, y + 18).lineTo(margin + contentWidth, y + 18).strokeColor('#f3f4f6').stroke();
              y += 18;
            }
          }

          // Section Subtotal
          doc.rect(margin, y, contentWidth, 20).fill('#e5e7eb');
          doc.font('Helvetica-Bold').fontSize(8).fillColor('#111827');
          doc.text(`TOTAL ${isRevenue ? 'REVENUE' : 'EXPENSES'}`, margin + 6, y + 6);
          doc.text(formatCurrencyDisplay(totalPaise), margin + 390, y + 6, {
            width: 120,
            align: 'right',
          });
          y += 28;
        };

        // Render Revenue
        renderSection('1. OPERATING REVENUE', report.revenue.accounts, report.revenue.totalRevenuePaise, true);

        // Render Expenses
        renderSection('2. OPERATING EXPENSES', report.expenses.accounts, report.expenses.totalExpensePaise, false);

        // Final Summary
        if (y > pageHeight - 70) {
          doc.addPage();
          y = margin;
        }

        doc.rect(margin, y, contentWidth, 26).fill('#111827');
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
        doc.text('NET INCOME (REVENUE - EXPENSES)', margin + 10, y + 8);
        doc.text(formatCurrencyDisplay(report.netIncomePaise), margin + 380, y + 8, {
          width: 125,
          align: 'right',
        });

        // Sign-off
        doc.font('Helvetica').fontSize(8).fillColor('#9ca3af');
        doc.text(
          'Authoritative profit & loss statement derived from immutable posted ledger accounts.',
          margin,
          pageHeight - 30,
          { align: 'center', width: contentWidth },
        );

        doc.end();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Generates authoritative binary PDF buffer for Balance Sheet.
   */
  async generateBalanceSheetPdf(report: BalanceSheetReport): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margin: 40,
          info: {
            Title: 'Balance Sheet',
            Author: 'Vishkaraa Naturals Private Limited',
            Subject: 'Authoritative Financial Statements',
            Creator: 'Vishkaraa Finance Reporting Engine',
          },
        });

        const buffers: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', (err) => {
          this.logger.error(`PDF generation error: ${err.message}`, err.stack);
          reject(err);
        });

        const pageWidth = 595.28;
        const pageHeight = 841.89;
        const margin = 40;
        const contentWidth = pageWidth - margin * 2;

        let y = margin;

        // Brand & Title
        doc.font('Helvetica-Bold').fontSize(18).fillColor('#059669');
        doc.text('VISHKARAA NATURALS', margin, y);
        doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827');
        doc.text('BALANCE SHEET', margin, y, { align: 'right', width: contentWidth });
        y += 24;

        // Subtitle / Period
        doc.font('Helvetica').fontSize(9).fillColor('#6b7280');
        const asOfText = `As Of: ${formatDate(report.asOf)} | Period: ${report.period.startDate ? formatDate(report.period.startDate) : 'Epoch'} to ${report.period.endDate ? formatDate(report.period.endDate) : 'Present'}`;
        doc.text(asOfText, margin, y);
        doc.text(`Generated: ${formatDate(new Date().toISOString())}`, margin, y, {
          align: 'right',
          width: contentWidth,
        });
        y += 20;

        // Helper to render balance sheet sections
        const renderSection = (
          title: string,
          accounts: BalanceSheetReport['assets']['accounts'],
          totalPaise: number,
        ) => {
          if (y > pageHeight - 80) {
            doc.addPage();
            y = margin;
          }

          doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827');
          doc.text(title, margin, y);
          y += 14;

          doc.rect(margin, y, contentWidth, 16).fill('#f3f4f6');
          doc.font('Helvetica-Bold').fontSize(8).fillColor('#374151');
          doc.text('Code', margin + 6, y + 4, { width: 70 });
          doc.text('Account Name', margin + 80, y + 4, { width: 300 });
          doc.text('Balance (INR)', margin + 390, y + 4, { width: 120, align: 'right' });
          y += 16;

          doc.font('Helvetica').fontSize(8);
          if (accounts.length === 0) {
            doc.fillColor('#6b7280').text('No accounts in this category.', margin + 10, y + 5);
            y += 16;
          } else {
            for (const item of accounts) {
              if (y > pageHeight - 45) {
                doc.addPage();
                y = margin;
              }
              doc.text(item.account.code, margin + 6, y + 4, { width: 70 });
              doc.text(item.account.name, margin + 80, y + 4, { width: 300 });
              doc.text(formatCurrencyDisplay(item.balancePaise), margin + 390, y + 4, {
                width: 120,
                align: 'right',
              });
              doc.moveTo(margin, y + 16).lineTo(margin + contentWidth, y + 16).strokeColor('#f3f4f6').stroke();
              y += 16;
            }
          }

          doc.rect(margin, y, contentWidth, 18).fill('#e5e7eb');
          doc.font('Helvetica-Bold').fontSize(8).fillColor('#111827');
          doc.text(`TOTAL ${title}`, margin + 6, y + 5);
          doc.text(formatCurrencyDisplay(totalPaise), margin + 390, y + 5, {
            width: 120,
            align: 'right',
          });
          y += 24;
        };

        // Render Assets, Liabilities, Equity
        renderSection('ASSETS', report.assets.accounts, report.assets.totalAssetsPaise);
        renderSection('LIABILITIES', report.liabilities.accounts, report.liabilities.totalLiabilitiesPaise);
        renderSection('EQUITY', report.equity.accounts, report.equity.totalEquityPaise);

        // Verification Card & Accounting Note
        if (y > pageHeight - 110) {
          doc.addPage();
          y = margin;
        }

        // Liabilities + Equity Summary Box
        doc.rect(margin, y, contentWidth, 22).fill('#374151');
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
        doc.text('TOTAL LIABILITIES + EQUITY', margin + 10, y + 6);
        doc.text(formatCurrencyDisplay(report.totalLiabilitiesAndEquityPaise), margin + 380, y + 6, {
          width: 125,
          align: 'right',
        });
        y += 28;

        // Reconciliation Note Box (Preserving unclosed net earnings truth)
        doc.rect(margin, y, contentWidth, 42).fillAndStroke('#eff6ff', '#bfdbfe');
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#1e40af');
        doc.text('ACCOUNTING RECONCILIATION NOTE', margin + 10, y + 6);
        doc.font('Helvetica').fontSize(8).fillColor('#1e3a8a');
        doc.text(
          `${report.reconciliationNote} Double-entry ledger invariant is strictly satisfied.`,
          margin + 10,
          y + 18,
          { width: contentWidth - 20 },
        );

        // Sign-off
        doc.font('Helvetica').fontSize(8).fillColor('#9ca3af');
        doc.text(
          'Authoritative balance sheet derived from immutable double-entry ledger without synthetic equity adjustments.',
          margin,
          pageHeight - 30,
          { align: 'center', width: contentWidth },
        );

        doc.end();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}
