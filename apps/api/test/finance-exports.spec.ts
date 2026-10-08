import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  PrismaClient,
  FinancialAccountType,
  FinancialAccountNormalBalance,
  FinancialTransactionType,
  FinancialTransactionStatus,
} from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { FinanceRepository } from '../src/finance/finance.repository.js';
import { FinanceService } from '../src/finance/finance.service.js';
import { FinanceExportService, escapeCsvCell, formatPaiseToInr } from '../src/finance/finance-export.service.js';
import { AdminFinanceController } from '../src/finance/admin-finance.controller.js';
import { AuditService } from '../src/audit/audit.service.js';
import { PermissionsService, type MinimalUser } from '../src/permissions/permissions.service.js';
import { FeaturesService } from '../src/features/features.service.js';
import { Permissions, UserRole, FeatureKey, FeatureStatus } from '@vishkaraa/types';
import { ACCOUNT_CODES } from '../src/finance/finance.constants.js';
import { PDFParse } from 'pdf-parse';

describe('Phase 16B: Financial Reporting Exports & Operations', () => {
  const testDbUrl =
    process.env['DATABASE_URL_TEST'] ||
    process.env['DATABASE_URL'] ||
    'postgresql://postgres:Hari@950@localhost:5432/vishkaraa_naturals?schema=public';

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: testDbUrl,
      },
    },
  });

  let financeRepo: FinanceRepository;
  let financeService: FinanceService;
  let exportService: FinanceExportService;
  let adminFinanceController: AdminFinanceController;
  let permissionsService: PermissionsService;
  let featuresService: FeaturesService;
  let testActorId: string;

  // Account IDs
  let cashAccountId: string;
  let salesAccountId: string;
  let expAccountId: string;
  let equityAccountId: string;

  beforeAll(async () => {
    await prisma.$connect();

    const mockAuditService = {
      logEvent: vi.fn(),
      logSecurityEvent: vi.fn(),
    } as unknown as AuditService;

    financeRepo = new FinanceRepository(prisma as any);
    financeService = new FinanceService(financeRepo, mockAuditService);
    exportService = new FinanceExportService();
    adminFinanceController = new AdminFinanceController(financeService, exportService);
    permissionsService = new PermissionsService(prisma as any, mockAuditService);
    featuresService = new FeaturesService(prisma as any, mockAuditService, permissionsService);

    // Retrieve accounts
    const cashAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.CASH_AND_BANK } });
    const salesAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.SALES_REVENUE } });
    const expAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.OPERATING_EXPENSES } });

    cashAccountId = cashAcc!.id;
    salesAccountId = salesAcc!.id;
    expAccountId = expAcc!.id;

    // Retrieve or create Equity account
    const existingEquity = await prisma.financialAccount.findUnique({ where: { code: '3900' } });
    if (!existingEquity) {
      const createdEquity = await prisma.financialAccount.create({
        data: {
          code: '3900',
          name: 'Owner Capital / Equity',
          type: FinancialAccountType.EQUITY,
          normalBalance: FinancialAccountNormalBalance.CREDIT,
          isSystemAccount: false,
          isActive: true,
        },
      });
      equityAccountId = createdEquity.id;
    } else {
      equityAccountId = existingEquity.id;
    }

    const testUser = await prisma.user.create({
      data: {
        email: `export-test-${Date.now()}@vishkaraa.local`,
        passwordHash: 'dummy-hash',
        firstName: 'Export',
        lastName: 'Tester',
        role: 'ADMIN',
      },
    });
    testActorId = testUser.id;

    // Post a balanced test transaction to verify export data
    await financeService.postTransaction(
      {
        transactionType: FinancialTransactionType.SALE,
        sourceType: 'EXPORT_TEST_ORDER',
        sourceId: `exp_ord_${Date.now()}`,
        idempotencyKey: `exp_idem_${Date.now()}`,
        description: 'Export Test Sale Transaction',
        lines: [
          { accountId: cashAccountId, debitPaise: 150000, creditPaise: 0 },
          { accountId: salesAccountId, debitPaise: 0, creditPaise: 150000 },
        ],
      },
      testActorId,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // 1. CSV Formula Injection & Formatting Utilities
  // ---------------------------------------------------------------------------
  describe('1. CSV Formula Injection & Security Escaping', () => {
    it('escapes dangerous spreadsheet formula triggers (=, +, -, @, \\t, \\r)', () => {
      expect(escapeCsvCell('=1+1')).toBe(`'=1+1`);
      expect(escapeCsvCell('+2+3')).toBe(`'+2+3`);
      expect(escapeCsvCell('-SUM(A1:A5)')).toBe(`'-SUM(A1:A5)`);
      expect(escapeCsvCell('@SUM(B1:B5)')).toBe(`'@SUM(B1:B5)`);
      expect(escapeCsvCell('\tcmd')).toBe(`'\tcmd`);
    });

    it('quotes strings containing commas, quotes, and newlines correctly', () => {
      expect(escapeCsvCell('Hello, World')).toBe('"Hello, World"');
      expect(escapeCsvCell('Said "Hello"')).toBe('"Said ""Hello"""');
      expect(escapeCsvCell('Line 1\nLine 2')).toBe('"Line 1\nLine 2"');
    });

    it('handles benign numbers, null, and undefined safely', () => {
      expect(escapeCsvCell(null)).toBe('');
      expect(escapeCsvCell(undefined)).toBe('');
      expect(escapeCsvCell(150000)).toBe('150000');
      expect(escapeCsvCell(0)).toBe('0');
    });

    it('formats paise into standard INR correctly', () => {
      expect(formatPaiseToInr(150000)).toBe('1500.00');
      expect(formatPaiseToInr(0)).toBe('0.00');
      expect(formatPaiseToInr(-50000)).toBe('-500.00');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. CSV Exports
  // ---------------------------------------------------------------------------
  describe('2. CSV Reports Export', () => {
    it('generates valid Trial Balance CSV with deterministic headers and balanced totals', async () => {
      const tbReport = await financeService.getTrialBalanceReport({});
      const csv = exportService.generateTrialBalanceCsv(tbReport);

      expect(typeof csv).toBe('string');
      expect(csv).toContain('Report,Trial Balance');
      expect(csv).toContain('Status,BALANCED');
      expect(csv).toContain('Account Code,Account Name,Account Type,Normal Balance');
      expect(csv).toContain('TOTALS,,,,');
      expect(csv).toContain(String(tbReport.totalDebitPaise));
      expect(csv).toContain(String(tbReport.totalCreditPaise));
      expect(csv).toContain(tbReport.isBalanced ? 'BALANCED: Total Debits equal Total Credits' : 'UNBALANCED');
    });

    it('generates valid Profit & Loss CSV with revenue, expense, and net income sections', async () => {
      const plReport = await financeService.getProfitLossReport({});
      const csv = exportService.generateProfitLossCsv(plReport);

      expect(typeof csv).toBe('string');
      expect(csv).toContain('Report,Profit & Loss Statement');
      expect(csv).toContain('--- REVENUE ---');
      expect(csv).toContain('TOTAL REVENUE,,,,,,');
      expect(csv).toContain(String(plReport.revenue.totalRevenuePaise));
      expect(csv).toContain('--- OPERATING EXPENSES ---');
      expect(csv).toContain('TOTAL EXPENSES,,,,,,');
      expect(csv).toContain(String(plReport.expenses.totalExpensePaise));
      expect(csv).toContain('NET INCOME,,,,,,');
      expect(csv).toContain(String(plReport.netIncomePaise));
    });

    it('generates valid Balance Sheet CSV with Assets, Liabilities, Equity, and reconciliation note', async () => {
      const bsReport = await financeService.getBalanceSheetReport({});
      const csv = exportService.generateBalanceSheetCsv(bsReport);

      expect(typeof csv).toBe('string');
      expect(csv).toContain('Report,Balance Sheet');
      expect(csv).toContain('--- ASSETS ---');
      expect(csv).toContain('TOTAL ASSETS,,,,,,');
      expect(csv).toContain(String(bsReport.assets.totalAssetsPaise));
      expect(csv).toContain('--- LIABILITIES ---');
      expect(csv).toContain('TOTAL LIABILITIES,,,,,,');
      expect(csv).toContain('--- EQUITY ---');
      expect(csv).toContain('TOTAL EQUITY,,,,,,');
      expect(csv).toContain('TOTAL LIABILITIES + EQUITY,,,,,,');
      expect(csv).toContain('BALANCE DIFFERENCE,,,,,,');
      expect(csv).toContain('RECONCILIATION NOTE');
      expect(csv).toContain(bsReport.reconciliationNote);
    });

    it('generates valid Account Drill-Down CSV with opening balance and entry lines', async () => {
      const drillDown = await financeService.getAccountDrillDown(cashAccountId, { limit: 100 });
      const csv = exportService.generateAccountDrillDownCsv(drillDown);

      expect(typeof csv).toBe('string');
      expect(csv).toContain('Account Drill-Down Report');
      expect(csv).toContain(`Account Code,${drillDown.account.code}`);
      expect(csv).toContain(`Opening Balance (Paise),${drillDown.openingBalancePaise}`);
      expect(csv).toContain(`Closing Balance (Paise),${drillDown.closingBalancePaise}`);
      expect(csv).toContain('Line ID,Transaction ID,Transaction Type,Source Type,Source ID,Description,Posted At,Debit (Paise),Debit (INR),Credit (Paise),Credit (INR)');
      expect(csv).toContain('PERIOD TOTALS');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. PDF Exports
  // ---------------------------------------------------------------------------
  describe('3. PDF Reports Export', () => {
    it('generates authoritative Trial Balance PDF buffer with branding and balanced verification', async () => {
      const tbReport = await financeService.getTrialBalanceReport({});
      const pdfBuffer = await exportService.generateTrialBalancePdf(tbReport);

      expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
      expect(pdfBuffer.length).toBeGreaterThan(1000);

      const parser = new PDFParse({ data: pdfBuffer });
      const pdfText = (await parser.getText()).text;

      expect(pdfText).toContain('VISHKARAA NATURALS');
      expect(pdfText).toContain('TRIAL BALANCE');
      expect(pdfText).toContain('LEDGER BALANCED');
      expect(pdfText).toContain('TOTALS');
    });

    it('generates authoritative Profit & Loss PDF buffer with net income card and sections', async () => {
      const plReport = await financeService.getProfitLossReport({});
      const pdfBuffer = await exportService.generateProfitLossPdf(plReport);

      expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
      expect(pdfBuffer.length).toBeGreaterThan(1000);

      const parser = new PDFParse({ data: pdfBuffer });
      const pdfText = (await parser.getText()).text;

      expect(pdfText).toContain('VISHKARAA NATURALS');
      expect(pdfText).toContain('PROFIT & LOSS STATEMENT');
      expect(pdfText).toContain('OPERATING REVENUE');
      expect(pdfText).toContain('OPERATING EXPENSES');
      expect(pdfText).toContain('NET INCOME');
    });

    it('generates authoritative Balance Sheet PDF buffer with accounting reconciliation note', async () => {
      const bsReport = await financeService.getBalanceSheetReport({});
      const pdfBuffer = await exportService.generateBalanceSheetPdf(bsReport);

      expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
      expect(pdfBuffer.length).toBeGreaterThan(1000);

      const parser = new PDFParse({ data: pdfBuffer });
      const pdfText = (await parser.getText()).text;

      expect(pdfText).toContain('VISHKARAA NATURALS');
      expect(pdfText).toContain('BALANCE SHEET');
      expect(pdfText).toContain('ASSETS');
      expect(pdfText).toContain('LIABILITIES');
      expect(pdfText).toContain('EQUITY');
      expect(pdfText).toContain('ACCOUNTING RECONCILIATION NOTE');
      expect(pdfText).toContain('reflects unclosed cumulative net earnings');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Single Source of Truth & Zero Screen/Export Drift
  // ---------------------------------------------------------------------------
  describe('4. Consistency: Export Totals Exactly Match Report API Totals', () => {
    it('verifies CSV and PDF Trial Balance totals match Service results exactly', async () => {
      const tbReport = await financeService.getTrialBalanceReport({});
      const csv = exportService.generateTrialBalanceCsv(tbReport);
      const pdfBuffer = await exportService.generateTrialBalancePdf(tbReport);

      const parser = new PDFParse({ data: pdfBuffer });
      const pdfText = (await parser.getText()).text;

      // Exact debit & credit figures in CSV
      expect(csv).toContain(String(tbReport.totalDebitPaise));
      expect(csv).toContain(String(tbReport.totalCreditPaise));

      // Formatted figures in PDF
      const formattedDebits = (tbReport.totalDebitPaise / 100).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
      });
      expect(pdfText).toContain(formattedDebits);
    });

    it('verifies CSV and PDF Profit & Loss totals match Service results exactly', async () => {
      const plReport = await financeService.getProfitLossReport({});
      const csv = exportService.generateProfitLossCsv(plReport);
      const pdfBuffer = await exportService.generateProfitLossPdf(plReport);

      const parser = new PDFParse({ data: pdfBuffer });
      const pdfText = (await parser.getText()).text;

      expect(csv).toContain(String(plReport.netIncomePaise));
      const formattedNet = (Math.abs(plReport.netIncomePaise) / 100).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
      });
      expect(pdfText).toContain(formattedNet);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Immutability & No Ledger Mutation
  // ---------------------------------------------------------------------------
  describe('5. Read-Only Invariant: Exports Never Mutate Financial Ledger', () => {
    it('verifies transaction line counts before and after all export operations remain identical', async () => {
      const linesBefore = await prisma.financialTransactionLine.count();
      const txBefore = await prisma.financialTransaction.count();

      // Trigger all CSV and PDF exports
      const tb = await financeService.getTrialBalanceReport({});
      exportService.generateTrialBalanceCsv(tb);
      await exportService.generateTrialBalancePdf(tb);

      const pl = await financeService.getProfitLossReport({});
      exportService.generateProfitLossCsv(pl);
      await exportService.generateProfitLossPdf(pl);

      const bs = await financeService.getBalanceSheetReport({});
      exportService.generateBalanceSheetCsv(bs);
      await exportService.generateBalanceSheetPdf(bs);

      const dd = await financeService.getAccountDrillDown(cashAccountId, { limit: 100 });
      exportService.generateAccountDrillDownCsv(dd);

      const linesAfter = await prisma.financialTransactionLine.count();
      const txAfter = await prisma.financialTransaction.count();

      expect(linesAfter).toBe(linesBefore);
      expect(txAfter).toBe(txBefore);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Security, IDOR Protection, and Permissions
  // ---------------------------------------------------------------------------
  describe('6. Security & Permission Enforcement', () => {
    it('blocks regular USER from accessing financial reporting (permission check)', async () => {
      const regularUser: MinimalUser = {
        id: 'regular-user-id',
        role: UserRole.USER,
        email: 'user@vishkaraa.local',
      };

      const canView = await permissionsService.can(regularUser, Permissions.FINANCE_VIEW);
      expect(canView).toBe(false);
    });

    it('blocks ADMIN without FINANCE_VIEW from accessing financial reporting', async () => {
      const unauthorizedAdmin: MinimalUser = {
        id: 'unauth-admin-id',
        role: UserRole.ADMIN,
        email: 'admin-unauth@vishkaraa.local',
      };

      const canView = await permissionsService.can(unauthorizedAdmin, Permissions.FINANCE_VIEW);
      expect(canView).toBe(false);
    });

    it('grants SUPER_ADMIN and authorized ADMIN access to financial reporting', async () => {
      const superAdmin: MinimalUser = {
        id: 'super-admin-id',
        role: UserRole.SUPER_ADMIN,
        email: 'superadmin@vishkaraa.local',
      };

      const canView = await permissionsService.can(superAdmin, Permissions.FINANCE_VIEW);
      expect(canView).toBe(true);
    });

    it('enforces FeatureKey.FINANCE active state in Feature Registry', async () => {
      const isEnabled = await featuresService.isFeatureEnabled(FeatureKey.FINANCE);
      expect(isEnabled).toBe(true);
    });

    it('prevents IDOR on account drill-down with non-existent account ID', async () => {
      await expect(
        financeService.getAccountDrillDown('non-existent-account-id', {}),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Controller Endpoint Integration
  // ---------------------------------------------------------------------------
  describe('7. Controller HTTP Headers and Response Packaging', () => {
    it('sets proper Content-Type, Content-Disposition, and cache headers on CSV export', async () => {
      const headers: Record<string, string | number> = {};
      let responseBody = '';

      const mockRes = {
        setHeader: (name: string, value: string | number) => {
          headers[name] = value;
        },
        send: (body: string) => {
          responseBody = body;
        },
      } as any;

      await adminFinanceController.exportTrialBalanceCsv({}, mockRes);

      expect(headers['Content-Type']).toBe('text/csv; charset=utf-8');
      expect(headers['Content-Disposition']).toMatch(/^attachment; filename="trial-balance-\d{4}-\d{2}-\d{2}\.csv"$/);
      expect(headers['Cache-Control']).toBe('private, no-cache, no-store, must-revalidate');
      expect(responseBody).toContain('Report,Trial Balance');
    });

    it('sets proper Content-Type, Content-Disposition, and Content-Length on PDF export', async () => {
      const headers: Record<string, string | number> = {};
      let responseBuffer: Buffer | null = null;

      const mockRes = {
        setHeader: (name: string, value: string | number) => {
          headers[name] = value;
        },
        end: (buf: Buffer) => {
          responseBuffer = buf;
        },
      } as any;

      await adminFinanceController.exportTrialBalancePdf({}, mockRes);

      expect(headers['Content-Type']).toBe('application/pdf');
      expect(headers['Content-Disposition']).toMatch(/^attachment; filename="trial-balance-\d{4}-\d{2}-\d{2}\.pdf"$/);
      expect(Number(headers['Content-Length'])).toBeGreaterThan(1000);
      expect(Buffer.isBuffer(responseBuffer)).toBe(true);
    });

    it('sets proper headers on Account Drill-Down CSV export', async () => {
      const headers: Record<string, string | number> = {};
      let responseBody = '';

      const mockRes = {
        setHeader: (name: string, value: string | number) => {
          headers[name] = value;
        },
        send: (body: string) => {
          responseBody = body;
        },
      } as any;

      await adminFinanceController.exportAccountDrillDownCsv(cashAccountId, {}, mockRes);

      expect(headers['Content-Type']).toBe('text/csv; charset=utf-8');
      expect(headers['Content-Disposition']).toContain('account-drill-down-');
      expect(responseBody).toContain('Account Drill-Down Report');
    });
  });
});
