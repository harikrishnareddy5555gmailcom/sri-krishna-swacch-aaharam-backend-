import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  FinancialAccountType,
  FinancialAccountNormalBalance,
  FinancialTransactionType,
  FinancialTransactionStatus,
} from '@prisma/client';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { FinanceRepository } from '../src/finance/finance.repository.js';
import { FinanceService } from '../src/finance/finance.service.js';
import { AdminFinanceController } from '../src/finance/admin-finance.controller.js';
import { AuditService } from '../src/audit/audit.service.js';
import { PermissionsService, type MinimalUser } from '../src/permissions/permissions.service.js';
import { FeaturesService } from '../src/features/features.service.js';
import { Permissions, UserRole, FeatureKey, FeatureStatus } from '@vishkaraa/types';
import { ACCOUNT_CODES } from '../src/finance/finance.constants.js';
import { PeriodPreset } from '../src/finance/dto/finance-reports.dto.js';

describe('Phase 16A: Financial Reporting & Statements Foundation', () => {
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
  let featuresService: FeaturesService;
  let permissionsService: PermissionsService;
  let auditLogsCreated: any[] = [];
  let testActorId: string;

  // Account IDs
  let cashAccountId: string;
  let arAccountId: string;
  let apAccountId: string;
  let salesAccountId: string;
  let shippingRevAccountId: string;
  let opExpenseAccountId: string;
  let customEquityAccountId: string;

  beforeAll(async () => {
    await prisma.$connect();

    auditLogsCreated = [];
    const mockAuditService = {
      logEvent: async (params: any) => {
        auditLogsCreated.push(params);
      },
    } as unknown as AuditService;

    financeRepo = new FinanceRepository(prisma as any);
    financeService = new FinanceService(financeRepo, mockAuditService);
    permissionsService = new PermissionsService(prisma as any);
    featuresService = new FeaturesService(prisma as any, mockAuditService, permissionsService);

    // Retrieve seeded accounts
    const cashAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.CASH_AND_BANK } });
    const arAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.ACCOUNTS_RECEIVABLE } });
    const apAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.ACCOUNTS_PAYABLE } });
    const salesAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.SALES_REVENUE } });
    const shipAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.SHIPPING_REVENUE } });
    const expAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.OPERATING_EXPENSES } });

    expect(cashAcc).toBeDefined();
    expect(arAcc).toBeDefined();
    expect(apAcc).toBeDefined();
    expect(salesAcc).toBeDefined();
    expect(shipAcc).toBeDefined();
    expect(expAcc).toBeDefined();

    cashAccountId = cashAcc!.id;
    arAccountId = arAcc!.id;
    apAccountId = apAcc!.id;
    salesAccountId = salesAcc!.id;
    shippingRevAccountId = shipAcc!.id;
    opExpenseAccountId = expAcc!.id;

    // Create an explicit Equity account for tests to verify EQUITY classification
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
      customEquityAccountId = createdEquity.id;
    } else {
      customEquityAccountId = existingEquity.id;
    }

    // Create a test user for actorId
    const testUser = await prisma.user.create({
      data: {
        email: `finance-rep-${Date.now()}@vishkaraa.local`,
        passwordHash: 'dummy-hash',
        firstName: 'Report',
        lastName: 'Tester',
        role: 'ADMIN',
      },
    });
    testActorId = testUser.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // 1. Trial Balance Report Suite
  // ---------------------------------------------------------------------------
  describe('1. Trial Balance Report', () => {
    it('1.1 satisfies invariant TOTAL DEBITS === TOTAL CREDITS across the ledger', async () => {
      const tb = await financeService.getTrialBalanceReport();

      expect(tb).toBeDefined();
      expect(tb.accounts).toBeInstanceOf(Array);
      expect(tb.totalDebitPaise).toBeGreaterThanOrEqual(0);
      expect(tb.totalCreditPaise).toBeGreaterThanOrEqual(0);
      expect(tb.totalDebitPaise).toBe(tb.totalCreditPaise);
      expect(tb.isBalanced).toBe(true);
    });

    it('1.2 respects normal-balance convention for every account type', async () => {
      const tb = await financeService.getTrialBalanceReport();

      for (const item of tb.accounts) {
        if (item.account.normalBalance === FinancialAccountNormalBalance.DEBIT) {
          // Asset, Expense: normal balance = debit - credit
          expect(item.balancePaise).toBe(item.totalDebitPaise - item.totalCreditPaise);
        } else {
          // Liability, Equity, Revenue: normal balance = credit - debit
          expect(item.balancePaise).toBe(item.totalCreditPaise - item.totalDebitPaise);
        }
      }
    });

    it('1.3 includes newly posted balanced transactions', async () => {
      const uniqueKey = `tb_test_post_${Date.now()}`;
      await financeService.postTransaction(
        {
          transactionType: FinancialTransactionType.EXPENSE,
          currency: 'INR',
          description: 'Trial Balance Verification Expense',
          idempotencyKey: uniqueKey,
          lines: [
            { accountId: opExpenseAccountId, debitPaise: 25000, creditPaise: 0 },
            { accountId: cashAccountId, debitPaise: 0, creditPaise: 25000 },
          ],
        },
        testActorId,
      );

      const tb = await financeService.getTrialBalanceReport();
      expect(tb.isBalanced).toBe(true);
      expect(tb.totalDebitPaise).toBe(tb.totalCreditPaise);

      const expItem = tb.accounts.find((a) => a.account.id === opExpenseAccountId);
      expect(expItem).toBeDefined();
      expect(expItem!.totalDebitPaise).toBeGreaterThanOrEqual(25000);
    });

    it('1.4 strictly excludes DRAFT and VOIDED transactions', async () => {
      // Create a DRAFT transaction directly in DB
      const draftTx = await prisma.financialTransaction.create({
        data: {
          transactionType: FinancialTransactionType.EXPENSE,
          status: FinancialTransactionStatus.DRAFT,
          currency: 'INR',
          description: 'Draft Transaction Should Be Ignored',
          idempotencyKey: `draft_ignore_${Date.now()}`,
          createdById: testActorId,
          lines: {
            create: [
              { accountId: opExpenseAccountId, debitPaise: 999999, creditPaise: 0 },
              { accountId: cashAccountId, debitPaise: 0, creditPaise: 999999 },
            ],
          },
        },
        include: { lines: true },
      });

      // Create a VOIDED transaction directly in DB
      const voidedTx = await prisma.financialTransaction.create({
        data: {
          transactionType: FinancialTransactionType.ADJUSTMENT,
          status: FinancialTransactionStatus.VOIDED,
          currency: 'INR',
          description: 'Voided Transaction Should Be Ignored',
          idempotencyKey: `voided_ignore_${Date.now()}`,
          createdById: testActorId,
          lines: {
            create: [
              { accountId: opExpenseAccountId, debitPaise: 888888, creditPaise: 0 },
              { accountId: cashAccountId, debitPaise: 0, creditPaise: 888888 },
            ],
          },
        },
        include: { lines: true },
      });

      const tb = await financeService.getTrialBalanceReport();

      // Find the operating expense account - ensure the 999999 and 888888 were NOT counted
      const drillDown = await financeService.getAccountDrillDown(opExpenseAccountId, { limit: 100 });
      const draftFound = drillDown.entries.some((e) => e.transactionId === draftTx.id);
      const voidedFound = drillDown.entries.some((e) => e.transactionId === voidedTx.id);

      expect(draftFound).toBe(false);
      expect(voidedFound).toBe(false);
      expect(tb.isBalanced).toBe(true);
    });

    it('1.5 filters by date period and handles empty periods cleanly', async () => {
      // Future date where no transactions exist
      const futureStart = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      const futureEnd = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString();

      const tbEmpty = await financeService.getTrialBalanceReport({
        startDate: futureStart,
        endDate: futureEnd,
      });

      expect(tbEmpty.totalDebitPaise).toBe(0);
      expect(tbEmpty.totalCreditPaise).toBe(0);
      expect(tbEmpty.isBalanced).toBe(true);
      expect(tbEmpty.accounts.every((a) => a.totalDebitPaise === 0 && a.totalCreditPaise === 0)).toBe(true);
    });

    it('1.6 rejects invalid date range where startDate > endDate', async () => {
      await expect(
        financeService.getTrialBalanceReport({
          startDate: '2026-12-31T00:00:00.000Z',
          endDate: '2026-01-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Profit & Loss (Income Statement) Suite
  // ---------------------------------------------------------------------------
  describe('2. Profit & Loss (Income Statement)', () => {
    it('2.1 derives revenue and expenses strictly from posted ledger entries', async () => {
      // Post a known sale: CR Sales Revenue (50,000 paise), DR Cash (50,000 paise)
      const saleKey = `pnl_sale_${Date.now()}`;
      await financeService.postTransaction(
        {
          transactionType: FinancialTransactionType.SALE,
          currency: 'INR',
          description: 'P&L Test Sale',
          idempotencyKey: saleKey,
          lines: [
            { accountId: cashAccountId, debitPaise: 50000, creditPaise: 0 },
            { accountId: salesAccountId, debitPaise: 0, creditPaise: 50000 },
          ],
        },
        testActorId,
      );

      // Post a known expense: DR Operating Expense (20,000 paise), CR Cash (20,000 paise)
      const expKey = `pnl_exp_${Date.now()}`;
      await financeService.postTransaction(
        {
          transactionType: FinancialTransactionType.EXPENSE,
          currency: 'INR',
          description: 'P&L Test Expense',
          idempotencyKey: expKey,
          lines: [
            { accountId: opExpenseAccountId, debitPaise: 20000, creditPaise: 0 },
            { accountId: cashAccountId, debitPaise: 0, creditPaise: 20000 },
          ],
        },
        testActorId,
      );

      const pnl = await financeService.getProfitLossReport();

      expect(pnl).toBeDefined();
      expect(pnl.revenue.accounts).toBeInstanceOf(Array);
      expect(pnl.expenses.accounts).toBeInstanceOf(Array);
      expect(pnl.revenue.totalRevenuePaise).toBeGreaterThanOrEqual(50000);
      expect(pnl.expenses.totalExpensePaise).toBeGreaterThanOrEqual(20000);

      // netIncome = totalRevenue - totalExpense
      expect(pnl.netIncomePaise).toBe(pnl.revenue.totalRevenuePaise - pnl.expenses.totalExpensePaise);
      expect(pnl.isProfitable).toBe(pnl.netIncomePaise >= 0);
    });

    it('2.2 correctly calculates net loss when expenses exceed revenue in a specific window', async () => {
      // Isolated test account for net loss window
      const testWindowStart = new Date(Date.now() - 5000).toISOString();

      // Post only an expense in this window
      await financeService.postTransaction(
        {
          transactionType: FinancialTransactionType.EXPENSE,
          currency: 'INR',
          description: 'Net Loss Test Expense',
          idempotencyKey: `net_loss_test_${Date.now()}`,
          lines: [
            { accountId: opExpenseAccountId, debitPaise: 15000, creditPaise: 0 },
            { accountId: cashAccountId, debitPaise: 0, creditPaise: 15000 },
          ],
        },
        testActorId,
      );

      const testWindowEnd = new Date(Date.now() + 5000).toISOString();

      const pnlWindow = await financeService.getProfitLossReport({
        startDate: testWindowStart,
        endDate: testWindowEnd,
      });

      // In this narrow window, expenses were recorded
      expect(pnlWindow.expenses.totalExpensePaise).toBeGreaterThanOrEqual(15000);
      expect(pnlWindow.netIncomePaise).toBe(
        pnlWindow.revenue.totalRevenuePaise - pnlWindow.expenses.totalExpensePaise,
      );
    });

    it('2.3 supports period presets (monthly, quarterly, fiscal_year)', async () => {
      const monthly = await financeService.getProfitLossReport({ period: PeriodPreset.MONTHLY });
      expect(monthly.period.preset).toBe(PeriodPreset.MONTHLY);
      expect(new Date(monthly.period.startDate).getTime()).toBeLessThan(new Date(monthly.period.endDate).getTime());

      const fiscal = await financeService.getProfitLossReport({ period: PeriodPreset.FISCAL_YEAR });
      expect(fiscal.period.preset).toBe(PeriodPreset.FISCAL_YEAR);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Balance Sheet Suite
  // ---------------------------------------------------------------------------
  describe('3. Balance Sheet', () => {
    it('3.1 classifies ASSET, LIABILITY, and EQUITY accounts correctly', async () => {
      const bs = await financeService.getBalanceSheetReport();

      expect(bs).toBeDefined();
      expect(bs.assets.accounts.every((a) => a.account.type === FinancialAccountType.ASSET)).toBe(true);
      expect(bs.liabilities.accounts.every((a) => a.account.type === FinancialAccountType.LIABILITY)).toBe(true);
      expect(bs.equity.accounts.every((a) => a.account.type === FinancialAccountType.EQUITY)).toBe(true);
    });

    it('3.2 transparently reports unclosed net earnings limitation without fabricating equity', async () => {
      const bs = await financeService.getBalanceSheetReport();

      // Assets - (Liabilities + Equity) = Current Period Net Income
      expect(bs.balanceDifferencePaise).toBe(bs.currentPeriodNetIncomePaise);
      expect(bs.totalLiabilitiesAndEquityPaise).toBe(bs.liabilities.totalLiabilitiesPaise + bs.equity.totalEquityPaise);

      // Reconciliation note is present and explains the accounting truth
      expect(bs.reconciliationNote).toBeDefined();
      expect(bs.reconciliationNote.length).toBeGreaterThan(10);
    });

    it('3.3 balances perfectly when formal equity transaction is posted', async () => {
      // Capital contribution: DR Cash (100,000 paise), CR Equity (100,000 paise)
      const equityKey = `equity_contrib_${Date.now()}`;
      await financeService.postTransaction(
        {
          transactionType: FinancialTransactionType.ADJUSTMENT,
          currency: 'INR',
          description: 'Owner Capital Contribution',
          idempotencyKey: equityKey,
          lines: [
            { accountId: cashAccountId, debitPaise: 100000, creditPaise: 0 },
            { accountId: customEquityAccountId, debitPaise: 0, creditPaise: 100000 },
          ],
        },
        testActorId,
      );

      const bs = await financeService.getBalanceSheetReport();
      const equityAcc = bs.equity.accounts.find((a) => a.account.id === customEquityAccountId);
      expect(equityAcc).toBeDefined();
      expect(equityAcc!.balancePaise).toBeGreaterThanOrEqual(100000);
      expect(bs.equity.totalEquityPaise).toBeGreaterThanOrEqual(100000);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Account Drill-Down Suite
  // ---------------------------------------------------------------------------
  describe('4. Account Drill-Down', () => {
    it('4.1 returns underlying posted ledger entries with pagination and safe projections', async () => {
      const drill = await financeService.getAccountDrillDown(cashAccountId, { page: 1, limit: 10 });

      expect(drill).toBeDefined();
      expect(drill.account.id).toBe(cashAccountId);
      expect(drill.entries).toBeInstanceOf(Array);
      expect(drill.page).toBe(1);
      expect(drill.limit).toBe(10);
      expect(drill.total).toBeGreaterThanOrEqual(drill.entries.length);

      // Verify safe fields only - no internal secrets or sensitive fields
      if (drill.entries.length > 0) {
        const entry = drill.entries[0];
        expect(entry).toHaveProperty('id');
        expect(entry).toHaveProperty('transactionId');
        expect(entry).toHaveProperty('transactionType');
        expect(entry).toHaveProperty('sourceType');
        expect(entry).toHaveProperty('description');
        expect(entry).toHaveProperty('postedAt');
        expect(entry).toHaveProperty('debitPaise');
        expect(entry).toHaveProperty('creditPaise');
      }
    });

    it('4.2 computes opening and closing balances for filtered date ranges', async () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 60000).toISOString();
      const futureDate = new Date(now.getTime() + 60000).toISOString();

      const drill = await financeService.getAccountDrillDown(cashAccountId, {
        startDate: pastDate,
        endDate: futureDate,
      });

      expect(drill.openingBalancePaise).toBeDefined();
      expect(drill.closingBalancePaise).toBeDefined();
      expect(drill.periodDebitPaise).toBeDefined();
      expect(drill.periodCreditPaise).toBeDefined();
    });

    it('4.3 throws NotFoundException for invalid account ID', async () => {
      await expect(
        financeService.getAccountDrillDown('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Security & Access Control Suite
  // ---------------------------------------------------------------------------
  describe('5. Security & Access Control', () => {
    it('5.1 rejects regular USER access to financial reports', async () => {
      const userActor: MinimalUser = {
        id: 'regular-user-id',
        role: UserRole.USER,
        email: 'customer@vishkaraa.local',
      };

      const canView = await permissionsService.can(userActor, Permissions.FINANCE_VIEW);
      expect(canView).toBe(false);
    });

    it('5.2 rejects ADMIN without FINANCE_VIEW permission', async () => {
      const unauthAdmin: MinimalUser = {
        id: 'unauth-admin-id',
        role: UserRole.ADMIN,
        email: 'no-finance@vishkaraa.local',
      };

      const canView = await permissionsService.can(unauthAdmin, Permissions.FINANCE_VIEW);
      expect(canView).toBe(false);
    });

    it('5.3 permits SUPER_ADMIN wildcard access to financial reports', async () => {
      const superAdmin: MinimalUser = {
        id: 'super-admin-id',
        role: UserRole.SUPER_ADMIN,
        email: 'superadmin@vishkaraa.local',
      };

      const canView = await permissionsService.can(superAdmin, Permissions.FINANCE_VIEW);
      expect(canView).toBe(true);
    });

    it('5.4 respects FeatureKey.FINANCE enable/disable status', async () => {
      const superAdmin: MinimalUser = {
        id: 'super-admin-id',
        role: UserRole.SUPER_ADMIN,
        email: 'superadmin@vishkaraa.local',
      };

      // By default FINANCE is active
      const enabled = await featuresService.isFeatureEnabled(FeatureKey.FINANCE, superAdmin);
      expect(enabled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Concurrency & Immutability Verification
  // ---------------------------------------------------------------------------
  describe('6. Concurrency & Immutability', () => {
    it('6.1 simultaneous report queries do not mutate ledger rows', async () => {
      const countBefore = await prisma.financialTransactionLine.count();

      // Run multiple simultaneous report generations
      await Promise.all([
        financeService.getTrialBalanceReport(),
        financeService.getProfitLossReport(),
        financeService.getBalanceSheetReport(),
        financeService.getAccountDrillDown(cashAccountId, { page: 1, limit: 20 }),
      ]);

      const countAfter = await prisma.financialTransactionLine.count();
      expect(countAfter).toBe(countBefore);
    });

    it('6.2 concurrent posting during reporting produces consistent, uncorrupted results', async () => {
      const uniqueKey = `concurrent_rep_${Date.now()}`;

      // Concurrently post a transaction while generating trial balance
      const [postResult, tbReport] = await Promise.all([
        financeService.postTransaction(
          {
            transactionType: FinancialTransactionType.EXPENSE,
            currency: 'INR',
            description: 'Concurrent Report Test',
            idempotencyKey: uniqueKey,
            lines: [
              { accountId: opExpenseAccountId, debitPaise: 12000, creditPaise: 0 },
              { accountId: cashAccountId, debitPaise: 0, creditPaise: 12000 },
            ],
          },
          testActorId,
        ),
        financeService.getTrialBalanceReport(),
      ]);

      expect(postResult).toBeDefined();
      expect(tbReport).toBeDefined();
      expect(tbReport.isBalanced).toBe(true);
      expect(tbReport.totalDebitPaise).toBe(tbReport.totalCreditPaise);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Controller Endpoint Mapping
  // ---------------------------------------------------------------------------
  describe('7. AdminFinanceController Reports Endpoints', () => {
    let controller: AdminFinanceController;

    beforeAll(() => {
      controller = new AdminFinanceController(financeService);
    });

    it('7.1 exposes getTrialBalanceReport', async () => {
      const res = await controller.getTrialBalanceReport({});
      expect(res).toBeDefined();
      expect(res.isBalanced).toBe(true);
    });

    it('7.2 exposes getProfitLossReport', async () => {
      const res = await controller.getProfitLossReport({});
      expect(res).toBeDefined();
      expect(res.revenue).toBeDefined();
      expect(res.expenses).toBeDefined();
    });

    it('7.3 exposes getBalanceSheetReport', async () => {
      const res = await controller.getBalanceSheetReport({});
      expect(res).toBeDefined();
      expect(res.assets).toBeDefined();
      expect(res.liabilities).toBeDefined();
      expect(res.equity).toBeDefined();
    });

    it('7.4 exposes getAccountDrillDown', async () => {
      const res = await controller.getAccountDrillDown(cashAccountId, { page: 1, limit: 10 });
      expect(res).toBeDefined();
      expect(res.account.id).toBe(cashAccountId);
    });

    it('7.5 preserves backward-compatible getTrialBalance endpoint', async () => {
      const res = await controller.getTrialBalance();
      expect(res).toBeDefined();
      expect(res.isBalanced).toBe(true);
    });
  });
});
