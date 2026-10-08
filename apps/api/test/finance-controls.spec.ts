import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  PrismaClient,
  FinancialAccountType,
  FinancialAccountNormalBalance,
  FinancialTransactionType,
  FinancialTransactionStatus,
  PaymentStatus,
  RefundStatus,
  ExpenseStatus,
} from '@prisma/client';
import { FinanceRepository } from '../src/finance/finance.repository.js';
import { FinanceService } from '../src/finance/finance.service.js';
import { FinanceExportService } from '../src/finance/finance-export.service.js';
import { FinanceControlsService } from '../src/finance/finance-controls.service.js';
import { AdminFinanceController } from '../src/finance/admin-finance.controller.js';
import { AuditService } from '../src/audit/audit.service.js';
import { PermissionsService, type MinimalUser } from '../src/permissions/permissions.service.js';
import { FeaturesService } from '../src/features/features.service.js';
import { Permissions, UserRole, FeatureKey } from '@vishkaraa/types';
import { ACCOUNT_CODES, FINANCE_SOURCE_TYPES } from '../src/finance/finance.constants.js';
import { ControlSeverity } from '../src/finance/dto/finance-controls.dto.js';

describe('Phase 16C: Production-Grade Financial Controls & Invariant Auditing', () => {
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
  let controlsService: FinanceControlsService;
  let adminFinanceController: AdminFinanceController;
  let permissionsService: PermissionsService;
  let featuresService: FeaturesService;
  let mockAuditService: AuditService;
  let testActorId: string;

  // Account IDs
  let cashAccountId: string;
  let salesAccountId: string;
  let arAccountId: string;
  let inactiveAccountId: string;

  // Track created entities for clean teardown
  const createdTxIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdPaymentIds: string[] = [];
  const createdRefundIds: string[] = [];
  const createdExpenseIds: string[] = [];
  const createdSessionIds: string[] = [];

  let sessionSeq = 0;
  async function createTestOrder(
    totalAmount: number,
    status: 'CONFIRMED' | 'DELIVERED' | 'CANCELLED' = 'CONFIRMED',
    currency = 'INR',
  ) {
    const session = await prisma.checkoutSession.create({
      data: {
        userId: testActorId,
        subtotal: totalAmount,
        currency,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    createdSessionIds.push(session.id);

    const payment = await prisma.paymentAttempt.create({
      data: {
        userId: testActorId,
        checkoutSessionId: session.id,
        amount: totalAmount,
        currency,
        status: PaymentStatus.CAPTURED,
        provider: 'MOCK',
      },
    });
    createdPaymentIds.push(payment.id);

    const order = await prisma.order.create({
      data: {
        orderNumber: `ORD-REC-${Date.now()}-${++sessionSeq}`,
        userId: testActorId,
        checkoutSessionId: session.id,
        paymentAttemptId: payment.id,
        subtotal: totalAmount,
        totalAmount,
        currency,
        status,
      },
    });
    createdOrderIds.push(order.id);
    return { order, payment, session };
  }

  beforeAll(async () => {
    await prisma.$connect();

    mockAuditService = {
      logEvent: vi.fn(),
      logSecurityEvent: vi.fn(),
    } as unknown as AuditService;

    financeRepo = new FinanceRepository(prisma as any);
    financeService = new FinanceService(financeRepo, mockAuditService);
    exportService = new FinanceExportService();
    controlsService = new FinanceControlsService(prisma as any);
    adminFinanceController = new AdminFinanceController(financeService, exportService, controlsService);
    permissionsService = new PermissionsService(prisma as any, mockAuditService);
    featuresService = new FeaturesService(prisma as any, mockAuditService, permissionsService);

    // Retrieve system accounts
    const cashAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.CASH_AND_BANK } });
    const salesAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.SALES_REVENUE } });
    const arAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.ACCOUNTS_RECEIVABLE } });

    cashAccountId = cashAcc!.id;
    salesAccountId = salesAcc!.id;
    arAccountId = arAcc!.id;

    // Create an inactive account to test inactive posting detection
    const inactiveAcc = await prisma.financialAccount.create({
      data: {
        code: `9999-INACTIVE-${Date.now()}`,
        name: 'Deprecated Inactive Account',
        type: FinancialAccountType.EXPENSE,
        normalBalance: FinancialAccountNormalBalance.DEBIT,
        isActive: false,
      },
    });
    inactiveAccountId = inactiveAcc.id;

    const testUser = await prisma.user.create({
      data: {
        email: `controls-test-${Date.now()}@vishkaraa.local`,
        passwordHash: 'dummy-hash',
        firstName: 'Controls',
        lastName: 'Tester',
        role: 'ADMIN',
      },
    });
    testActorId = testUser.id;
  });

  afterAll(async () => {
    // Clean up created test entities in dependency order
    if (createdTxIds.length > 0) {
      await prisma.financialTransactionLine.deleteMany({
        where: { transactionId: { in: createdTxIds } },
      });
      await prisma.financialTransaction.deleteMany({
        where: { id: { in: createdTxIds } },
      });
    }

    if (createdExpenseIds.length > 0) {
      await prisma.expense.deleteMany({
        where: { id: { in: createdExpenseIds } },
      });
    }

    if (createdRefundIds.length > 0) {
      await prisma.refund.deleteMany({
        where: { id: { in: createdRefundIds } },
      });
    }

    if (createdOrderIds.length > 0) {
      await prisma.orderItem.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
      await prisma.order.deleteMany({
        where: { id: { in: createdOrderIds } },
      });
    }

    if (createdPaymentIds.length > 0) {
      await prisma.paymentAttempt.deleteMany({
        where: { id: { in: createdPaymentIds } },
      });
    }

    if (createdSessionIds.length > 0) {
      await prisma.checkoutSession.deleteMany({
        where: { id: { in: createdSessionIds } },
      });
    }

    if (inactiveAccountId) {
      await prisma.financialAccount.delete({
        where: { id: inactiveAccountId },
      }).catch(() => {});
    }

    if (testActorId) {
      await prisma.user.delete({
        where: { id: testActorId },
      }).catch(() => {});
    }

    await prisma.$disconnect();
  });

  // ===========================================================================
  // 1. LEDGER INTEGRITY CONTROL TESTS
  // ===========================================================================
  describe('1. Ledger Integrity Control', () => {
    it('balanced POSTED transaction passes with zero violations', async () => {
      const validTx = await prisma.financialTransaction.create({
        data: {
          transactionType: FinancialTransactionType.SALE,
          status: FinancialTransactionStatus.POSTED,
          currency: 'INR',
          description: 'Valid balanced transaction',
          idempotencyKey: `ctrl_valid_${Date.now()}`,
          createdById: testActorId,
          postedAt: new Date(),
          lines: {
            create: [
              { accountId: cashAccountId, debitPaise: 50000, creditPaise: 0 },
              { accountId: salesAccountId, debitPaise: 0, creditPaise: 50000 },
            ],
          },
        },
      });
      createdTxIds.push(validTx.id);

      const result = await controlsService.verifyLedgerIntegrity({ limit: 50 });
      const txFindings = result.findings.filter((f) => f.transactionId === validTx.id);
      expect(txFindings).toHaveLength(0);
    });

    it('detects unbalanced POSTED transaction (Rule: LI_UNBALANCED_TRANSACTION)', async () => {
      // Intentionally insert an unbalanced transaction in DB (bypassing service layer to simulate corruption)
      const unbalTx = await prisma.financialTransaction.create({
        data: {
          transactionType: FinancialTransactionType.ADJUSTMENT,
          status: FinancialTransactionStatus.POSTED,
          currency: 'INR',
          description: 'Corrupted unbalanced transaction',
          idempotencyKey: `ctrl_unbal_${Date.now()}`,
          createdById: testActorId,
          postedAt: new Date(),
          lines: {
            create: [
              { accountId: cashAccountId, debitPaise: 100000, creditPaise: 0 },
              { accountId: salesAccountId, debitPaise: 0, creditPaise: 80000 },
            ],
          },
        },
      });

      try {
        const result = await controlsService.verifyLedgerIntegrity({ limit: 50 });
        const finding = result.findings.find(
          (f) => f.transactionId === unbalTx.id && f.ruleCode === 'LI_UNBALANCED_TRANSACTION',
        );

        expect(finding).toBeDefined();
        expect(finding?.severity).toBe(ControlSeverity.CRITICAL);
        expect(finding?.expectedAmountPaise).toBe(100000);
        expect(finding?.actualAmountPaise).toBe(80000);
        expect(result.stats.status).toBe('FAILED');
      } finally {
        await prisma.financialTransactionLine.deleteMany({ where: { transactionId: unbalTx.id } });
        await prisma.financialTransaction.delete({ where: { id: unbalTx.id } });
      }
    });

    it('detects insufficient lines (< 2) on POSTED transaction', async () => {
      const singleLineTx = await prisma.financialTransaction.create({
        data: {
          transactionType: FinancialTransactionType.ADJUSTMENT,
          status: FinancialTransactionStatus.POSTED,
          currency: 'INR',
          description: 'Single line anomaly',
          idempotencyKey: `ctrl_single_${Date.now()}`,
          createdById: testActorId,
          postedAt: new Date(),
          lines: {
            create: [
              { accountId: cashAccountId, debitPaise: 25000, creditPaise: 0 },
            ],
          },
        },
      });

      try {
        const result = await controlsService.verifyLedgerIntegrity({ limit: 50 });
        const finding = result.findings.find(
          (f) => f.transactionId === singleLineTx.id && f.ruleCode === 'LI_INSUFFICIENT_LINES',
        );

        expect(finding).toBeDefined();
        expect(finding?.severity).toBe(ControlSeverity.CRITICAL);
      } finally {
        await prisma.financialTransactionLine.deleteMany({ where: { transactionId: singleLineTx.id } });
        await prisma.financialTransaction.delete({ where: { id: singleLineTx.id } });
      }
    });

    it('detects posting to an inactive account (Rule: LI_INACTIVE_ACCOUNT_POSTING)', async () => {
      const inactiveTx = await prisma.financialTransaction.create({
        data: {
          transactionType: FinancialTransactionType.EXPENSE,
          status: FinancialTransactionStatus.POSTED,
          currency: 'INR',
          description: 'Transaction with inactive account',
          idempotencyKey: `ctrl_inact_${Date.now()}`,
          createdById: testActorId,
          postedAt: new Date(),
          lines: {
            create: [
              { accountId: inactiveAccountId, debitPaise: 12000, creditPaise: 0 },
              { accountId: cashAccountId, debitPaise: 0, creditPaise: 12000 },
            ],
          },
        },
      });

      try {
        const result = await controlsService.verifyLedgerIntegrity({ limit: 50 });
        const finding = result.findings.find(
          (f) => f.transactionId === inactiveTx.id && f.ruleCode === 'LI_INACTIVE_ACCOUNT_POSTING',
        );

        expect(finding).toBeDefined();
        expect(finding?.severity).toBe(ControlSeverity.WARNING);
      } finally {
        await prisma.financialTransactionLine.deleteMany({ where: { transactionId: inactiveTx.id } });
        await prisma.financialTransaction.delete({ where: { id: inactiveTx.id } });
      }
    });

    it('excludes DRAFT and VOIDED transactions from integrity violations', async () => {
      // DRAFT transaction with single line (valid for draft state)
      const draftTx = await prisma.financialTransaction.create({
        data: {
          transactionType: FinancialTransactionType.ADJUSTMENT,
          status: FinancialTransactionStatus.DRAFT,
          currency: 'INR',
          description: 'Draft unposted transaction',
          idempotencyKey: `ctrl_draft_${Date.now()}`,
          createdById: testActorId,
          lines: {
            create: [
              { accountId: cashAccountId, debitPaise: 10000, creditPaise: 0 },
            ],
          },
        },
      });
      createdTxIds.push(draftTx.id);

      // VOIDED transaction with single line
      const voidedTx = await prisma.financialTransaction.create({
        data: {
          transactionType: FinancialTransactionType.VOID,
          status: FinancialTransactionStatus.VOIDED,
          currency: 'INR',
          description: 'Voided transaction',
          idempotencyKey: `ctrl_void_${Date.now()}`,
          createdById: testActorId,
          voidedAt: new Date(),
          lines: {
            create: [
              { accountId: cashAccountId, debitPaise: 10000, creditPaise: 0 },
            ],
          },
        },
      });
      createdTxIds.push(voidedTx.id);

      const result = await controlsService.verifyLedgerIntegrity({ limit: 50 });
      const draftFinding = result.findings.find((f) => f.transactionId === draftTx.id);
      const voidedFinding = result.findings.find((f) => f.transactionId === voidedTx.id);

      expect(draftFinding).toBeUndefined();
      expect(voidedFinding).toBeUndefined();
    });
  });

  // ===========================================================================
  // 2. FINANCIAL RECONCILIATION CONTROLS TESTS
  // ===========================================================================
  describe('2. Financial Reconciliation Controls', () => {
    it('detects missing ledger transaction for confirmed order', async () => {
      const { order } = await createTestOrder(118000, 'CONFIRMED');

      const result = await controlsService.runDomainReconciliations({ limit: 50 });
      const finding = result.findings.find(
        (f) => f.sourceId === order.id && f.ruleCode === 'REC_ORDER_MISSING_TRANSACTION',
      );

      expect(finding).toBeDefined();
      expect(finding?.severity).toBe(ControlSeverity.CRITICAL);
      expect(finding?.expectedAmountPaise).toBe(118000);
      expect(result.domainStats.orders.missing).toBeGreaterThanOrEqual(1);
    });

    it('detects amount mismatch between order and SALE ledger transaction', async () => {
      const { order } = await createTestOrder(118000, 'CONFIRMED');

      // Create a ledger tx with mismatched amount (e.g. 100000 instead of 118000)
      const mismatchedTx = await prisma.financialTransaction.create({
        data: {
          transactionType: FinancialTransactionType.SALE,
          status: FinancialTransactionStatus.POSTED,
          currency: 'INR',
          sourceType: FINANCE_SOURCE_TYPES.ORDER,
          sourceId: order.id,
          description: `Sale for order ${order.id}`,
          idempotencyKey: `ctrl_ord_mismatch_${Date.now()}`,
          createdById: testActorId,
          postedAt: new Date(),
          lines: {
            create: [
              { accountId: arAccountId, debitPaise: 100000, creditPaise: 0 },
              { accountId: salesAccountId, debitPaise: 0, creditPaise: 100000 },
            ],
          },
        },
      });
      createdTxIds.push(mismatchedTx.id);

      const result = await controlsService.runDomainReconciliations({ limit: 50 });
      const finding = result.findings.find(
        (f) => f.sourceId === order.id && f.ruleCode === 'REC_ORDER_AMOUNT_MISMATCH',
      );

      expect(finding).toBeDefined();
      expect(finding?.severity).toBe(ControlSeverity.CRITICAL);
      expect(finding?.expectedAmountPaise).toBe(118000);
      expect(finding?.actualAmountPaise).toBe(100000);
    });

    it('detects currency mismatch between order and SALE ledger transaction', async () => {
      const { order } = await createTestOrder(50000, 'CONFIRMED', 'INR');

      const currencyMismatchTx = await prisma.financialTransaction.create({
        data: {
          transactionType: FinancialTransactionType.SALE,
          status: FinancialTransactionStatus.POSTED,
          currency: 'USD', // Mismatch!
          sourceType: FINANCE_SOURCE_TYPES.ORDER,
          sourceId: order.id,
          description: `Sale for order ${order.id}`,
          idempotencyKey: `ctrl_ord_curr_${Date.now()}`,
          createdById: testActorId,
          postedAt: new Date(),
          lines: {
            create: [
              { accountId: arAccountId, debitPaise: 50000, creditPaise: 0 },
              { accountId: salesAccountId, debitPaise: 0, creditPaise: 50000 },
            ],
          },
        },
      });
      createdTxIds.push(currencyMismatchTx.id);

      const result = await controlsService.runDomainReconciliations({ limit: 50 });
      const finding = result.findings.find(
        (f) => f.sourceId === order.id && f.ruleCode === 'REC_ORDER_CURRENCY_MISMATCH',
      );

      expect(finding).toBeDefined();
      expect(finding?.severity).toBe(ControlSeverity.WARNING);
      expect(finding?.currency).toBe('USD');
    });

    it('detects duplicate ledger transactions for same order', async () => {
      const { order } = await createTestOrder(40000, 'CONFIRMED');

      const tx1 = await prisma.financialTransaction.create({
        data: {
          transactionType: FinancialTransactionType.SALE,
          status: FinancialTransactionStatus.POSTED,
          currency: 'INR',
          sourceType: FINANCE_SOURCE_TYPES.ORDER,
          sourceId: order.id,
          description: `Tx 1 for order ${order.id}`,
          idempotencyKey: `ctrl_ord_dup1_${Date.now()}`,
          createdById: testActorId,
          postedAt: new Date(),
          lines: {
            create: [
              { accountId: arAccountId, debitPaise: 40000, creditPaise: 0 },
              { accountId: salesAccountId, debitPaise: 0, creditPaise: 40000 },
            ],
          },
        },
      });
      createdTxIds.push(tx1.id);

      const tx2 = await prisma.financialTransaction.create({
        data: {
          transactionType: FinancialTransactionType.SALE,
          status: FinancialTransactionStatus.POSTED,
          currency: 'INR',
          sourceType: FINANCE_SOURCE_TYPES.ORDER,
          sourceId: order.id,
          description: `Tx 2 for order ${order.id}`,
          idempotencyKey: `ctrl_ord_dup2_${Date.now()}`,
          createdById: testActorId,
          postedAt: new Date(),
          lines: {
            create: [
              { accountId: arAccountId, debitPaise: 40000, creditPaise: 0 },
              { accountId: salesAccountId, debitPaise: 0, creditPaise: 40000 },
            ],
          },
        },
      });
      createdTxIds.push(tx2.id);

      const result = await controlsService.runDomainReconciliations({ limit: 50 });
      const finding = result.findings.find(
        (f) => f.sourceId === order.id && f.ruleCode === 'REC_ORDER_DUPLICATE_TRANSACTION',
      );

      expect(finding).toBeDefined();
      expect(finding?.severity).toBe(ControlSeverity.CRITICAL);
    });

    it('detects orphan transaction referencing non-existent order (Rule: REC_INVALID_SOURCE_REFERENCE)', async () => {
      const nonExistentOrderId = '00000000-0000-0000-0000-000000000099';
      const orphanTx = await prisma.financialTransaction.create({
        data: {
          transactionType: FinancialTransactionType.SALE,
          status: FinancialTransactionStatus.POSTED,
          currency: 'INR',
          sourceType: FINANCE_SOURCE_TYPES.ORDER,
          sourceId: nonExistentOrderId,
          description: 'Orphan transaction',
          idempotencyKey: `ctrl_ord_orphan_${Date.now()}`,
          createdById: testActorId,
          postedAt: new Date(),
          lines: {
            create: [
              { accountId: arAccountId, debitPaise: 30000, creditPaise: 0 },
              { accountId: salesAccountId, debitPaise: 0, creditPaise: 30000 },
            ],
          },
        },
      });
      createdTxIds.push(orphanTx.id);

      const result = await controlsService.runDomainReconciliations({ limit: 50 });
      const finding = result.findings.find(
        (f) => f.transactionId === orphanTx.id && f.ruleCode === 'REC_INVALID_SOURCE_REFERENCE',
      );

      expect(finding).toBeDefined();
      expect(finding?.severity).toBe(ControlSeverity.CRITICAL);
    });

    it('detects missing ledger transaction for CAPTURED payment', async () => {
      const session = await prisma.checkoutSession.create({
        data: {
          userId: testActorId,
          subtotal: 75000,
          currency: 'INR',
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      createdSessionIds.push(session.id);

      const payment = await prisma.paymentAttempt.create({
        data: {
          userId: testActorId,
          checkoutSessionId: session.id,
          amount: 75000,
          currency: 'INR',
          status: PaymentStatus.CAPTURED,
          provider: 'MOCK',
        },
      });
      createdPaymentIds.push(payment.id);

      const result = await controlsService.runDomainReconciliations({ limit: 50 });
      const finding = result.findings.find(
        (f) => f.sourceId === payment.id && f.ruleCode === 'REC_PAYMENT_MISSING_TRANSACTION',
      );

      expect(finding).toBeDefined();
      expect(finding?.severity).toBe(ControlSeverity.CRITICAL);
      expect(finding?.expectedAmountPaise).toBe(75000);
    });

    it('detects missing ledger transaction for COMPLETED refund', async () => {
      const { order, payment } = await createTestOrder(20000, 'DELIVERED');

      const refund = await prisma.refund.create({
        data: {
          refundNumber: `RF-REC-${Date.now()}`,
          orderId: order.id,
          paymentAttemptId: payment.id,
          userId: testActorId,
          type: 'FULL',
          status: RefundStatus.COMPLETED,
          amount: 20000,
          reason: 'Customer return',
          requestedById: testActorId,
        },
      });
      createdRefundIds.push(refund.id);

      const result = await controlsService.runDomainReconciliations({ limit: 50 });
      const finding = result.findings.find(
        (f) => f.sourceId === refund.id && f.ruleCode === 'REC_REFUND_MISSING_TRANSACTION',
      );

      expect(finding).toBeDefined();
      expect(finding?.severity).toBe(ControlSeverity.CRITICAL);
      expect(finding?.expectedAmountPaise).toBe(20000);
    });

    it('detects missing ledger transaction for POSTED expense', async () => {
      const expense = await prisma.expense.create({
        data: {
          expenseNumber: `EXP-REC-${Date.now()}`,
          category: 'OFFICE_SUPPLIES',
          vendor: 'Stationery Co',
          description: 'Office paper & ink',
          amountPaise: 4500,
          currency: 'INR',
          expenseDate: new Date(),
          status: ExpenseStatus.POSTED,
          isPaid: true,
        },
      });
      createdExpenseIds.push(expense.id);

      const result = await controlsService.runDomainReconciliations({ limit: 50 });
      const finding = result.findings.find(
        (f) => f.sourceId === expense.id && f.ruleCode === 'REC_EXPENSE_MISSING_TRANSACTION',
      );

      expect(finding).toBeDefined();
      expect(finding?.severity).toBe(ControlSeverity.CRITICAL);
      expect(finding?.expectedAmountPaise).toBe(4500);
    });
  });

  // ===========================================================================
  // 3. COMBINED CONTROLS REPORT & READ-ONLY FIRST VERIFICATION
  // ===========================================================================
  describe('3. Combined Controls Report & Read-Only Invariants', () => {
    it('returns structured machine-readable report with complete stats', async () => {
      const report = await controlsService.runAllControls({ limit: 100 });

      expect(report.summary).toBeDefined();
      expect(report.summary.status).toBeDefined();
      expect(report.summary.totalChecksRun).toBeGreaterThanOrEqual(1);
      expect(report.summary.passedCount).toBeGreaterThanOrEqual(0);
      expect(typeof report.summary.executionTimeMs).toBe('number');
      expect(report.summary.domainReconciliations.orders).toBeDefined();
      expect(report.summary.domainReconciliations.payments).toBeDefined();
      expect(report.summary.domainReconciliations.refunds).toBeDefined();
      expect(report.summary.domainReconciliations.expenses).toBeDefined();
      expect(Array.isArray(report.findings)).toBe(true);
    });

    it('read-only invariant: running controls does NOT mutate database records or audit logs', async () => {
      const txCountBefore = await prisma.financialTransaction.count();
      const lineCountBefore = await prisma.financialTransactionLine.count();
      const orderCountBefore = await prisma.order.count();
      const paymentCountBefore = await prisma.paymentAttempt.count();

      // Clear mock audit call counts
      vi.clearAllMocks();

      // Execute controls check
      await controlsService.runAllControls();

      const txCountAfter = await prisma.financialTransaction.count();
      const lineCountAfter = await prisma.financialTransactionLine.count();
      const orderCountAfter = await prisma.order.count();
      const paymentCountAfter = await prisma.paymentAttempt.count();

      expect(txCountAfter).toBe(txCountBefore);
      expect(lineCountAfter).toBe(lineCountBefore);
      expect(orderCountAfter).toBe(orderCountBefore);
      expect(paymentCountAfter).toBe(paymentCountBefore);
      // No audit event emitted merely by diagnostic query
      expect(mockAuditService.logEvent).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 4. ADMIN API, SECURITY & PERMISSION ISOLATION
  // ===========================================================================
  describe('4. Security & Permission Isolation', () => {
    it('controller delegates correctly to FinanceControlsService', async () => {
      const report = await adminFinanceController.getControlsReport({});
      expect(report.summary).toBeDefined();
      expect(report.findings).toBeDefined();

      const ledger = await adminFinanceController.getLedgerIntegrityCheck({});
      expect(ledger.stats).toBeDefined();

      const reconciliations = await adminFinanceController.getDomainReconciliations({});
      expect(reconciliations.domainStats).toBeDefined();
    });

    it('USER role has zero access to FINANCE.VIEW', async () => {
      const regularUser: MinimalUser = {
        id: 'regular-user-id',
        role: UserRole.USER,
        email: 'user@vishkaraa.local',
      };

      const hasView = await permissionsService.can(regularUser, Permissions.FINANCE_VIEW);
      expect(hasView).toBe(false);
    });

    it('ADMIN role requires explicit FINANCE.VIEW permission', async () => {
      const adminWithoutPerm: MinimalUser = {
        id: 'admin-unprivileged-id',
        role: UserRole.ADMIN,
        email: 'admin-noperm@vishkaraa.local',
      };

      const hasView = await permissionsService.can(adminWithoutPerm, Permissions.FINANCE_VIEW);
      expect(hasView).toBe(false);
    });

    it('SUPER_ADMIN role inherently possesses FINANCE.VIEW authority', async () => {
      const superAdmin: MinimalUser = {
        id: 'super-admin-id',
        role: UserRole.SUPER_ADMIN,
        email: 'super@vishkaraa.local',
      };

      const hasView = await permissionsService.can(superAdmin, Permissions.FINANCE_VIEW);
      expect(hasView).toBe(true);
    });

    it('FINANCE feature flag check operates consistently', async () => {
      const regularAdmin: MinimalUser = {
        id: 'admin-test-id',
        role: UserRole.ADMIN,
        email: 'admin@vishkaraa.local',
      };

      const isEnabled = await featuresService.isFeatureEnabled(FeatureKey.FINANCE, regularAdmin);
      expect(typeof isEnabled).toBe('boolean');
    });
  });
});
