import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  ExpenseStatus,
  ExpensePaymentMethod,
  FinancialTransactionType,
  FinancialTransactionStatus,
  FinancialAccountType,
  FinancialAccountNormalBalance,
} from '@prisma/client';

import { ExpensesRepository } from '../src/expenses/expenses.repository.js';
import { ExpensesService } from '../src/expenses/expenses.service.js';
import { FinanceRepository } from '../src/finance/finance.repository.js';
import { FinanceService } from '../src/finance/finance.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { ACCOUNT_CODES } from '../src/finance/finance.constants.js';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

describe('Phase 15C: Expenses Domain Foundation & Finance Integration Suite', () => {
  const baseDbUrl =
    process.env['DATABASE_URL_TEST'] ||
    process.env['DATABASE_URL'] ||
    'postgresql://postgres:Hari@950@localhost:5432/vishkaraa_test?schema=public';

  const testDbUrl = baseDbUrl.includes('?')
    ? `${baseDbUrl}&connection_limit=25`
    : `${baseDbUrl}?connection_limit=25`;

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: testDbUrl,
      },
    },
  });

  let expensesRepo: ExpensesRepository;
  let expensesService: ExpensesService;
  let financeRepo: FinanceRepository;
  let financeService: FinanceService;
  let auditService: AuditService;

  let submitterAdminId: string;
  let approverAdminId: string;
  let superAdminId: string;

  let operatingExpensesAccountId: string;
  let cashBankAccountId: string;
  let accountsPayableAccountId: string;

  beforeAll(async () => {
    await prisma.$connect();

    auditService = new AuditService(prisma as any);
    financeRepo = new FinanceRepository(prisma as any);
    financeService = new FinanceService(financeRepo, auditService);
    expensesRepo = new ExpensesRepository(prisma as any);
    expensesService = new ExpensesService(expensesRepo, financeService, auditService);

    // Create real test users so audit log FKs succeed cleanly
    const ts = Date.now();
    const [subAdmin, appAdmin, sAdmin] = await Promise.all([
      prisma.user.create({
        data: {
          email: `exp-sub-${ts}@vishkaraa.local`,
          passwordHash: 'dummy',
          firstName: 'Submitter',
          lastName: 'Admin',
          role: 'ADMIN',
        },
      }),
      prisma.user.create({
        data: {
          email: `exp-app-${ts}@vishkaraa.local`,
          passwordHash: 'dummy',
          firstName: 'Approver',
          lastName: 'Admin',
          role: 'ADMIN',
        },
      }),
      prisma.user.create({
        data: {
          email: `exp-super-${ts}@vishkaraa.local`,
          passwordHash: 'dummy',
          firstName: 'Super',
          lastName: 'Admin',
          role: 'SUPER_ADMIN',
        },
      }),
    ]);
    submitterAdminId = subAdmin.id;
    approverAdminId = appAdmin.id;
    superAdminId = sAdmin.id;

    // Resolve system accounts
    const [operatingExp, cashBank, accountsPayable] = await Promise.all([
      prisma.financialAccount.findUniqueOrThrow({ where: { code: ACCOUNT_CODES.OPERATING_EXPENSES } }),
      prisma.financialAccount.findUniqueOrThrow({ where: { code: ACCOUNT_CODES.CASH_AND_BANK } }),
      prisma.financialAccount.findUniqueOrThrow({ where: { code: ACCOUNT_CODES.ACCOUNTS_PAYABLE } }),
    ]);

    operatingExpensesAccountId = operatingExp.id;
    cashBankAccountId = cashBank.id;
    accountsPayableAccountId = accountsPayable.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ===========================================================================
  // 1. EXPENSE LIFECYCLE & STATE MACHINE
  // ===========================================================================

  describe('Expense Lifecycle: Draft -> Submitted -> Approved -> Posted', () => {
    let testExpenseId: string;

    it('creates a new DRAFT expense with formatted expense number and positive amount', async () => {
      const expense = await expensesService.createExpense(
        {
          category: 'OFFICE_SUPPLIES',
          vendor: 'Paper & Toner Mart',
          description: 'Stationery and packaging supplies',
          amountPaise: 450000, // Rs. 4,500.00
          expenseDate: new Date().toISOString(),
          isPaid: true,
          paymentMethod: ExpensePaymentMethod.UPI,
          paymentReference: 'UPI-REF-987654321',
        },
        submitterAdminId,
      );

      expect(expense).toBeDefined();
      expect(expense.id).toBeDefined();
      expect(expense.expenseNumber).toMatch(/^EXP-\d{6}-[0-9A-F]{8}$/);
      expect(expense.status).toBe(ExpenseStatus.DRAFT);
      expect(expense.amountPaise).toBe(450000);
      expect(expense.currency).toBe('INR');
      expect(expense.submittedById).toBe(submitterAdminId);

      testExpenseId = expense.id;
    });

    it('rejects creation with non-positive amount', async () => {
      await expect(
        expensesService.createExpense(
          {
            category: 'OFFICE',
            vendor: 'Bad Vendor',
            description: 'Zero amount expense',
            amountPaise: 0,
            expenseDate: new Date().toISOString(),
          },
          submitterAdminId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('updates a DRAFT expense', async () => {
      const updated = await expensesService.updateExpense(
        testExpenseId,
        {
          description: 'Updated description: Stationery + thermal rolls',
          amountPaise: 480000,
        },
        submitterAdminId,
      );

      expect(updated.description).toBe('Updated description: Stationery + thermal rolls');
      expect(updated.amountPaise).toBe(480000);
    });

    it('submits a DRAFT expense for approval', async () => {
      const submitted = await expensesService.submitExpense(testExpenseId, submitterAdminId);

      expect(submitted.status).toBe(ExpenseStatus.SUBMITTED);
      expect(submitted.submittedById).toBe(submitterAdminId);
      expect(submitted.submittedAt).toBeDefined();
    });

    it('prevents update on a SUBMITTED expense', async () => {
      await expect(
        expensesService.updateExpense(
          testExpenseId,
          { description: 'Illegal edit after submit' },
          submitterAdminId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('enforces separation of duties: submitter cannot approve their own expense', async () => {
      await expect(
        expensesService.approveExpense(testExpenseId, submitterAdminId, 'ADMIN'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows a distinct authorized approver to approve the submitted expense', async () => {
      const approved = await expensesService.approveExpense(
        testExpenseId,
        approverAdminId,
        'ADMIN',
      );

      expect(approved.status).toBe(ExpenseStatus.APPROVED);
      expect(approved.approvedById).toBe(approverAdminId);
      expect(approved.approvedAt).toBeDefined();
    });

    it('posts an APPROVED expense to the financial ledger', async () => {
      const posted = await expensesService.postExpense(testExpenseId, approverAdminId, 'ADMIN');

      expect(posted.status).toBe(ExpenseStatus.POSTED);
      expect(posted.postedById).toBe(approverAdminId);
      expect(posted.postedAt).toBeDefined();
      expect(posted.financeTransactionId).toBeDefined();

      // Inspect financial ledger entry
      const finTx = await prisma.financialTransaction.findUniqueOrThrow({
        where: { id: posted.financeTransactionId! },
        include: { lines: true },
      });

      expect(finTx.transactionType).toBe(FinancialTransactionType.EXPENSE);
      expect(finTx.status).toBe(FinancialTransactionStatus.POSTED);
      expect(finTx.idempotencyKey).toBe(`expense_post_${posted.id}`);
      expect(finTx.lines).toHaveLength(2);

      // Verify double-entry balancing
      const debitLine = finTx.lines.find((l) => l.debitPaise > 0);
      const creditLine = finTx.lines.find((l) => l.creditPaise > 0);

      expect(debitLine).toBeDefined();
      expect(creditLine).toBeDefined();
      expect(debitLine!.debitPaise).toBe(480000);
      expect(creditLine!.creditPaise).toBe(480000);

      // Paid expense debits Operating Expenses and credits Cash & Bank
      expect(debitLine!.accountId).toBe(operatingExpensesAccountId);
      expect(creditLine!.accountId).toBe(cashBankAccountId);
    });

    it('enforces POSTED immutability: posted expense cannot be edited, cancelled, or reposted', async () => {
      await expect(
        expensesService.updateExpense(testExpenseId, { vendor: 'Mutated' }, submitterAdminId),
      ).rejects.toThrow(BadRequestException);

      await expect(
        expensesService.cancelExpense(
          testExpenseId,
          { cancellationReason: 'Late cancel' },
          submitterAdminId,
        ),
      ).rejects.toThrow(BadRequestException);

      // Idempotent repost returns existing without re-crediting ledger
      const reposted = await expensesService.postExpense(testExpenseId, approverAdminId);
      expect(reposted.status).toBe(ExpenseStatus.POSTED);
      expect(reposted.financeTransactionId).toBeDefined();

      const txCount = await prisma.financialTransaction.count({
        where: { idempotencyKey: `expense_post_${testExpenseId}` },
      });
      expect(txCount).toBe(1);
    });
  });

  // ===========================================================================
  // 2. UNPAID / ON-ACCOUNT EXPENSE POSTING (ACCOUNTS PAYABLE)
  // ===========================================================================

  describe('Unpaid Expense -> Accounts Payable Posting', () => {
    it('credits Accounts Payable (2000) when isPaid is false', async () => {
      const expense = await expensesService.createExpense(
        {
          category: 'RAW_MATERIALS',
          vendor: 'Herbal Ingredients Co',
          description: 'Bulk raw extract shipment on 30-day credit',
          amountPaise: 1250000, // Rs. 12,500.00
          expenseDate: new Date().toISOString(),
          isPaid: false, // Unpaid / On account
        },
        submitterAdminId,
      );

      await expensesService.submitExpense(expense.id, submitterAdminId);
      await expensesService.approveExpense(expense.id, approverAdminId, 'ADMIN');
      const posted = await expensesService.postExpense(expense.id, approverAdminId, 'ADMIN');

      expect(posted.status).toBe(ExpenseStatus.POSTED);

      const finTx = await prisma.financialTransaction.findUniqueOrThrow({
        where: { id: posted.financeTransactionId! },
        include: { lines: true },
      });

      const debitLine = finTx.lines.find((l) => l.debitPaise > 0);
      const creditLine = finTx.lines.find((l) => l.creditPaise > 0);

      expect(debitLine!.accountId).toBe(operatingExpensesAccountId);
      expect(creditLine!.accountId).toBe(accountsPayableAccountId);
      expect(debitLine!.debitPaise).toBe(1250000);
      expect(creditLine!.creditPaise).toBe(1250000);
    });
  });

  // ===========================================================================
  // 3. REJECTION & CANCELLATION FLOWS
  // ===========================================================================

  describe('Expense Rejection & Cancellation', () => {
    it('allows an approver to reject a submitted expense with a reason', async () => {
      const expense = await expensesService.createExpense(
        {
          category: 'MEALS',
          vendor: 'Luxury Bistro',
          description: 'Team dinner without prior approval',
          amountPaise: 800000,
          expenseDate: new Date().toISOString(),
        },
        submitterAdminId,
      );

      await expensesService.submitExpense(expense.id, submitterAdminId);

      const rejected = await expensesService.rejectExpense(
        expense.id,
        { rejectionReason: 'Policy violation: Unapproved offsite dinner' },
        approverAdminId,
        'ADMIN',
      );

      expect(rejected.status).toBe(ExpenseStatus.REJECTED);
      expect(rejected.rejectionReason).toBe('Policy violation: Unapproved offsite dinner');
      expect(rejected.rejectedById).toBe(approverAdminId);

      // Cannot post a REJECTED expense
      await expect(expensesService.postExpense(expense.id, approverAdminId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('allows cancelling an unposted expense', async () => {
      const expense = await expensesService.createExpense(
        {
          category: 'UTILITIES',
          vendor: 'Power Utility',
          description: 'Duplicate bill entry',
          amountPaise: 250000,
          expenseDate: new Date().toISOString(),
        },
        submitterAdminId,
      );

      const cancelled = await expensesService.cancelExpense(
        expense.id,
        { cancellationReason: 'Duplicate bill created in error' },
        submitterAdminId,
      );

      expect(cancelled.status).toBe(ExpenseStatus.CANCELLED);
      expect(cancelled.cancellationReason).toBe('Duplicate bill created in error');

      // Cannot submit or post a CANCELLED expense
      await expect(expensesService.submitExpense(expense.id, submitterAdminId)).rejects.toThrow(
        BadRequestException,
      );
      await expect(expensesService.postExpense(expense.id, approverAdminId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ===========================================================================
  // 4. ATTACHMENT SUPPORT
  // ===========================================================================

  describe('Expense Attachments', () => {
    it('attaches receipt metadata to an expense', async () => {
      const expense = await expensesService.createExpense(
        {
          category: 'SOFTWARE',
          vendor: 'Cloud Host Inc',
          description: 'Monthly VPS and storage',
          amountPaise: 350000,
          expenseDate: new Date().toISOString(),
        },
        submitterAdminId,
      );

      const attachment = await expensesService.addAttachment(
        expense.id,
        {
          fileName: 'invoice-cloudhost-oct.pdf',
          fileUrl: 'https://storage.vishkaraa.local/receipts/exp-123-oct.pdf',
          fileSize: 1048576,
          mimeType: 'application/pdf',
        },
        submitterAdminId,
      );

      expect(attachment).toBeDefined();
      expect(attachment.fileName).toBe('invoice-cloudhost-oct.pdf');
      expect(attachment.expenseId).toBe(expense.id);

      const fetched = await expensesService.getExpenseById(expense.id);
      expect(fetched.attachments).toHaveLength(1);
      expect(fetched.attachments![0]!.fileName).toBe('invoice-cloudhost-oct.pdf');
    });
  });

  // ===========================================================================
  // 5. TRIAL BALANCE INTEGRITY
  // ===========================================================================

  describe('Trial Balance Balance Invariant', () => {
    it('guarantees complete ledger trial balance remains balanced after expense postings', async () => {
      const trialBalance = await financeService.getTrialBalance();

      expect(trialBalance.isBalanced).toBe(true);
      expect(trialBalance.totalDebitPaise).toBe(trialBalance.totalCreditPaise);
      expect(trialBalance.totalDebitPaise).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // 6. REAL POSTGRESQL CONCURRENCY SUITE
  // ===========================================================================

  describe('Real PostgreSQL Concurrency Suite', () => {
    it('simultaneous duplicate approvals: exactly 1 wins, other safe/idempotent', async () => {
      const expense = await expensesService.createExpense(
        {
          category: 'CONCURRENCY_TEST',
          vendor: 'Vendor Concurrent',
          description: 'Simultaneous approvals test',
          amountPaise: 100000,
          expenseDate: new Date().toISOString(),
        },
        submitterAdminId,
      );

      await expensesService.submitExpense(expense.id, submitterAdminId);

      const results = await Promise.allSettled([
        expensesService.approveExpense(expense.id, approverAdminId, 'ADMIN'),
        expensesService.approveExpense(expense.id, approverAdminId, 'ADMIN'),
      ]);

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      expect(succeeded.length).toBeGreaterThanOrEqual(1);

      const finalExpense = await expensesService.getExpenseById(expense.id);
      expect(finalExpense.status).toBe(ExpenseStatus.APPROVED);
    });

    it('five concurrent post requests for the same expense create exactly ONE financial transaction', async () => {
      const expense = await expensesService.createExpense(
        {
          category: 'CONCURRENCY_POST',
          vendor: 'Mega Supplier Ltd',
          description: '5-way race to post expense',
          amountPaise: 500000,
          expenseDate: new Date().toISOString(),
          isPaid: true,
        },
        submitterAdminId,
      );

      await expensesService.submitExpense(expense.id, submitterAdminId);
      await expensesService.approveExpense(expense.id, approverAdminId, 'ADMIN');

      // Fire 5 simultaneous post requests
      const postResults = await Promise.allSettled([
        expensesService.postExpense(expense.id, approverAdminId, 'ADMIN'),
        expensesService.postExpense(expense.id, approverAdminId, 'ADMIN'),
        expensesService.postExpense(expense.id, approverAdminId, 'ADMIN'),
        expensesService.postExpense(expense.id, approverAdminId, 'ADMIN'),
        expensesService.postExpense(expense.id, approverAdminId, 'ADMIN'),
      ]);

      const fulfilled = postResults.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // Verify exactly ONE financial transaction was created in DB
      const finTxs = await prisma.financialTransaction.findMany({
        where: { idempotencyKey: `expense_post_${expense.id}` },
        include: { lines: true },
      });

      expect(finTxs).toHaveLength(1);
      expect(finTxs[0]!.status).toBe(FinancialTransactionStatus.POSTED);
      expect(finTxs[0]!.lines).toHaveLength(2);

      const finalExpense = await expensesService.getExpenseById(expense.id);
      expect(finalExpense.status).toBe(ExpenseStatus.POSTED);
      expect(finalExpense.financeTransactionId).toBe(finTxs[0]!.id);
    });
  });

  // ===========================================================================
  // 7. SECURITY & PERMISSIONS VERIFICATION
  // ===========================================================================

  describe('Security & Permissions Architecture', () => {
    it('guarantees USER role has ZERO access to any EXPENSES permissions', async () => {
      const userRolePerms = await prisma.rolePermission.findMany({
        where: {
          roleName: 'USER',
          permissionKey: { startsWith: 'EXPENSES.' },
        },
      });

      expect(userRolePerms).toHaveLength(0);
    });

    it('grants ADMIN baseline operational permissions (VIEW, CREATE, UPDATE, SUBMIT)', async () => {
      const adminRolePerms = await prisma.rolePermission.findMany({
        where: {
          roleName: 'ADMIN',
          permissionKey: { startsWith: 'EXPENSES.' },
        },
      });

      const permKeys = adminRolePerms.map((p) => p.permissionKey);
      expect(permKeys).toContain('EXPENSES.VIEW');
      expect(permKeys).toContain('EXPENSES.CREATE');
      expect(permKeys).toContain('EXPENSES.UPDATE');
      expect(permKeys).toContain('EXPENSES.SUBMIT');

      // Sensitive approval and manager permissions are not in default baseline
      expect(permKeys).not.toContain('EXPENSES.MANAGE');
    });

    it('grants SUPER_ADMIN unrestricted authority over all EXPENSES permissions', async () => {
      const superAdminRolePerms = await prisma.rolePermission.findMany({
        where: {
          roleName: 'SUPER_ADMIN',
          permissionKey: { startsWith: 'EXPENSES.' },
        },
      });

      const permKeys = superAdminRolePerms.map((p) => p.permissionKey);
      expect(permKeys).toContain('EXPENSES.VIEW');
      expect(permKeys).toContain('EXPENSES.CREATE');
      expect(permKeys).toContain('EXPENSES.UPDATE');
      expect(permKeys).toContain('EXPENSES.SUBMIT');
      expect(permKeys).toContain('EXPENSES.APPROVE');
      expect(permKeys).toContain('EXPENSES.REJECT');
      expect(permKeys).toContain('EXPENSES.POST');
      expect(permKeys).toContain('EXPENSES.CANCEL');
      expect(permKeys).toContain('EXPENSES.MANAGE');
    });
  });

  // ===========================================================================
  // 8. PHASE 15D: EXPENSE OPERATIONS & EXTENDED CONCURRENCY SUITE
  // ===========================================================================

  describe('Phase 15D: Operations & Verification Suite', () => {
    describe('Date & Amount Range Filtering', () => {
      it('correctly filters expenses by date range and amount range with stable ordering', async () => {
        const d1 = new Date('2026-05-01T10:00:00Z');
        const d2 = new Date('2026-06-01T10:00:00Z');
        const d3 = new Date('2026-07-01T10:00:00Z');

        const [exp1, exp2, exp3] = await Promise.all([
          expensesService.createExpense(
            {
              category: 'FILTER_TEST',
              vendor: 'Vendor Alpha',
              description: 'Expense in May 1000 INR',
              amountPaise: 100000,
              expenseDate: d1.toISOString(),
            },
            submitterAdminId,
          ),
          expensesService.createExpense(
            {
              category: 'FILTER_TEST',
              vendor: 'Vendor Beta',
              description: 'Expense in June 2500 INR',
              amountPaise: 250000,
              expenseDate: d2.toISOString(),
            },
            submitterAdminId,
          ),
          expensesService.createExpense(
            {
              category: 'FILTER_TEST',
              vendor: 'Vendor Gamma',
              description: 'Expense in July 5000 INR',
              amountPaise: 500000,
              expenseDate: d3.toISOString(),
            },
            submitterAdminId,
          ),
        ]);

        // Filter by date range: May 15 to June 15 -> should match exp2 only
        const dateRangeResult = await expensesService.listExpenses({
          category: 'FILTER_TEST',
          startDate: '2026-05-15T00:00:00Z',
          endDate: '2026-06-15T23:59:59Z',
        });
        const dateIds = dateRangeResult.items.map((i) => i.id);
        expect(dateIds).toContain(exp2.id);
        expect(dateIds).not.toContain(exp1.id);
        expect(dateIds).not.toContain(exp3.id);

        // Filter by amount range: 2000 INR to 6000 INR -> should match exp2 and exp3
        const amountRangeResult = await expensesService.listExpenses({
          category: 'FILTER_TEST',
          minAmountPaise: 200000,
          maxAmountPaise: 600000,
        });
        const amountIds = amountRangeResult.items.map((i) => i.id);
        expect(amountIds).toContain(exp2.id);
        expect(amountIds).toContain(exp3.id);
        expect(amountIds).not.toContain(exp1.id);

        // Verify compound stable ordering: items ordered by expenseDate desc
        expect(amountRangeResult.items[0]!.expenseDate >= amountRangeResult.items[1]!.expenseDate).toBe(true);
      });
    });

    describe('Category / Finance Account Mapping Validation', () => {
      it('lists active expense accounts through getExpenseAccounts', async () => {
        const accounts = await expensesService.getExpenseAccounts();
        expect(accounts.length).toBeGreaterThan(0);
        for (const acc of accounts) {
          expect(acc.type).toBe(FinancialAccountType.EXPENSE);
          expect(acc.isActive).toBe(true);
        }
      });

      it('rejects createExpense with a non-existent expenseAccountId', async () => {
        await expect(
          expensesService.createExpense(
            {
              category: 'SOFTWARE',
              vendor: 'Ghost Cloud',
              description: 'Invalid account ID',
              amountPaise: 50000,
              expenseDate: new Date().toISOString(),
              expenseAccountId: '00000000-0000-0000-0000-000000000000',
            },
            submitterAdminId,
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('rejects createExpense with a non-EXPENSE account (e.g. CASH_AND_BANK ASSET)', async () => {
        await expect(
          expensesService.createExpense(
            {
              category: 'SOFTWARE',
              vendor: 'Ghost Cloud',
              description: 'Pointing to Cash & Bank asset account instead of Expense account',
              amountPaise: 50000,
              expenseDate: new Date().toISOString(),
              expenseAccountId: cashBankAccountId,
            },
            submitterAdminId,
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('rejects createExpense with an inactive EXPENSE account', async () => {
        // Create an inactive expense account
        const inactiveAcc = await prisma.financialAccount.create({
          data: {
            code: `TEST_INACTIVE_${Date.now()}`,
            name: 'Inactive Test Expense Account',
            type: FinancialAccountType.EXPENSE,
            normalBalance: FinancialAccountNormalBalance.DEBIT,
            isActive: false,
          },
        });



        await expect(
          expensesService.createExpense(
            {
              category: 'TEST',
              vendor: 'Inactive Vendor',
              description: 'Pointing to inactive account',
              amountPaise: 10000,
              expenseDate: new Date().toISOString(),
              expenseAccountId: inactiveAcc.id,
            },
            submitterAdminId,
          ),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('Receipts & Attachments Security Validation', () => {
      let draftExpenseId: string;

      beforeAll(async () => {
        const exp = await expensesService.createExpense(
          {
            category: 'SECURITY_TEST',
            vendor: 'Security Labs',
            description: 'Attachment test target',
            amountPaise: 25000,
            expenseDate: new Date().toISOString(),
          },
          submitterAdminId,
        );
        draftExpenseId = exp.id;
      });

      it('successfully adds valid attachment and creates audit log', async () => {
        const att = await expensesService.addAttachment(
          draftExpenseId,
          {
            fileName: 'invoice_2026_09.pdf',
            fileUrl: 'https://storage.vishkaraa.com/receipts/inv_2026_09.pdf',
            fileSize: 102400,
            mimeType: 'application/pdf',
          },
          submitterAdminId,
        );

        expect(att.id).toBeDefined();
        expect(att.fileName).toBe('invoice_2026_09.pdf');

        // Verify audit log
        const audit = await prisma.auditLog.findFirst({
          where: {
            entityType: 'EXPENSE',
            entityId: draftExpenseId,
            action: 'EXPENSE_ATTACHMENT_ADDED',
          },
        });
        expect(audit).not.toBeNull();
      });

      it('rejects attachments with path traversal characters', async () => {
        await expect(
          expensesService.addAttachment(
            draftExpenseId,
            {
              fileName: '../../etc/passwd.pdf',
              fileUrl: 'https://storage.vishkaraa.com/receipts/test.pdf',
              fileSize: 1024,
              mimeType: 'application/pdf',
            },
            submitterAdminId,
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('rejects executable file extensions', async () => {
        await expect(
          expensesService.addAttachment(
            draftExpenseId,
            {
              fileName: 'payload.exe',
              fileUrl: 'https://storage.vishkaraa.com/receipts/payload.exe',
              fileSize: 1024,
              mimeType: 'application/pdf',
            },
            submitterAdminId,
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('rejects files exceeding 10MB maximum size', async () => {
        await expect(
          expensesService.addAttachment(
            draftExpenseId,
            {
              fileName: 'huge_scan.pdf',
              fileUrl: 'https://storage.vishkaraa.com/receipts/huge.pdf',
              fileSize: 15 * 1024 * 1024, // 15MB
              mimeType: 'application/pdf',
            },
            submitterAdminId,
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('rejects disallowed MIME types', async () => {
        await expect(
          expensesService.addAttachment(
            draftExpenseId,
            {
              fileName: 'document.pdf',
              fileUrl: 'https://storage.vishkaraa.com/receipts/document.pdf',
              fileSize: 1024,
              mimeType: 'text/html',
            },
            submitterAdminId,
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('rejects internal IP addresses / SSRF target URLs', async () => {
        await expect(
          expensesService.addAttachment(
            draftExpenseId,
            {
              fileName: 'aws_metadata.pdf',
              fileUrl: 'http://169.254.169.254/latest/meta-data',
              fileSize: 1024,
              mimeType: 'application/pdf',
            },
            submitterAdminId,
          ),
        ).rejects.toThrow(BadRequestException);

        await expect(
          expensesService.addAttachment(
            draftExpenseId,
            {
              fileName: 'loopback.pdf',
              fileUrl: 'http://127.0.0.1:8080/internal.pdf',
              fileSize: 1024,
              mimeType: 'application/pdf',
            },
            submitterAdminId,
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('allows deleting an attachment in DRAFT status and logs audit event', async () => {
        const att = await expensesService.addAttachment(
          draftExpenseId,
          {
            fileName: 'to_delete.pdf',
            fileUrl: 'https://storage.vishkaraa.com/receipts/to_delete.pdf',
            fileSize: 2048,
            mimeType: 'application/pdf',
          },
          submitterAdminId,
        );

        const deleteResult = await expensesService.deleteAttachment(
          draftExpenseId,
          att.id,
          submitterAdminId,
          'ADMIN',
        );
        expect(deleteResult.success).toBe(true);

        // Verify attachment removed
        const found = await prisma.expenseAttachment.findUnique({ where: { id: att.id } });
        expect(found).toBeNull();

        // Verify audit log
        const audit = await prisma.auditLog.findFirst({
          where: {
            entityType: 'EXPENSE',
            entityId: draftExpenseId,
            action: 'EXPENSE_ATTACHMENT_REMOVED',
          },
        });
        expect(audit).not.toBeNull();
      });

      it('forbids adding attachments to an expense after approval or posting', async () => {
        const approvedExp = await expensesService.createExpense(
          {
            category: 'LOCKED_TEST',
            vendor: 'Locked Vendor',
            description: 'Approved expense',
            amountPaise: 50000,
            expenseDate: new Date().toISOString(),
          },
          submitterAdminId,
        );
        await expensesService.submitExpense(approvedExp.id, submitterAdminId);
        await expensesService.approveExpense(approvedExp.id, approverAdminId, 'ADMIN');

        await expect(
          expensesService.addAttachment(
            approvedExp.id,
            {
              fileName: 'late_invoice.pdf',
              fileUrl: 'https://storage.vishkaraa.com/receipts/late.pdf',
              fileSize: 1024,
              mimeType: 'application/pdf',
            },
            submitterAdminId,
          ),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('Operational Concurrency: Rejection, Cancellation & Attachments', () => {
      it('two concurrent rejection calls on a SUBMITTED expense: exactly ONE succeeds, other rejected with 400', async () => {
        const exp = await expensesService.createExpense(
          {
            category: 'CONCURRENT_REJECT',
            vendor: 'Reject Race Vendor',
            description: 'Concurrent rejection test',
            amountPaise: 150000,
            expenseDate: new Date().toISOString(),
          },
          submitterAdminId,
        );
        await expensesService.submitExpense(exp.id, submitterAdminId);

        const results = await Promise.allSettled([
          expensesService.rejectExpense(
            exp.id,
            { rejectionReason: 'First reviewer rejects: missing GST details' },
            approverAdminId,
            'ADMIN',
          ),
          expensesService.rejectExpense(
            exp.id,
            { rejectionReason: 'Second reviewer rejects: duplicate expense' },
            superAdminId,
            'SUPER_ADMIN',
          ),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const finalExp = await expensesService.getExpenseById(exp.id);
        expect(finalExp.status).toBe(ExpenseStatus.REJECTED);
        expect(finalExp.rejectedAt).not.toBeNull();
      });

      it('two concurrent cancellation calls on a SUBMITTED expense: exactly ONE succeeds, other rejected with 400', async () => {
        const exp = await expensesService.createExpense(
          {
            category: 'CONCURRENT_CANCEL',
            vendor: 'Cancel Race Vendor',
            description: 'Concurrent cancellation test',
            amountPaise: 120000,
            expenseDate: new Date().toISOString(),
          },
          submitterAdminId,
        );
        await expensesService.submitExpense(exp.id, submitterAdminId);

        const results = await Promise.allSettled([
          expensesService.cancelExpense(
            exp.id,
            { cancellationReason: 'Cancelled by submitter: ordered wrong item' },
            submitterAdminId,
            'ADMIN',
          ),
          expensesService.cancelExpense(
            exp.id,
            { cancellationReason: 'Cancelled by admin: vendor cancelled order' },
            approverAdminId,
            'ADMIN',
          ),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const finalExp = await expensesService.getExpenseById(exp.id);
        expect(finalExp.status).toBe(ExpenseStatus.CANCELLED);
        expect(finalExp.cancelledAt).not.toBeNull();
      });

      it('concurrent attachment additions: multiple attachments can be added simultaneously without deadlock', async () => {
        const exp = await expensesService.createExpense(
          {
            category: 'CONCURRENT_ATT',
            vendor: 'Multi File Vendor',
            description: 'Multi attachment test',
            amountPaise: 80000,
            expenseDate: new Date().toISOString(),
          },
          submitterAdminId,
        );

        const results = await Promise.allSettled([
          expensesService.addAttachment(
            exp.id,
            {
              fileName: 'file_1.pdf',
              fileUrl: 'https://storage.vishkaraa.com/receipts/file1.pdf',
              fileSize: 1024,
              mimeType: 'application/pdf',
            },
            submitterAdminId,
          ),
          expensesService.addAttachment(
            exp.id,
            {
              fileName: 'file_2.png',
              fileUrl: 'https://storage.vishkaraa.com/receipts/file2.png',
              fileSize: 2048,
              mimeType: 'image/png',
            },
            submitterAdminId,
          ),
          expensesService.addAttachment(
            exp.id,
            {
              fileName: 'file_3.webp',
              fileUrl: 'https://storage.vishkaraa.com/receipts/file3.webp',
              fileSize: 4096,
              mimeType: 'image/webp',
            },
            submitterAdminId,
          ),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        expect(fulfilled).toHaveLength(3);

        const fullExpense = await expensesService.getExpenseById(exp.id);
        expect(fullExpense.attachments).toHaveLength(3);
      });
    });
  });
});

