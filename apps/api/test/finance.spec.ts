import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  FinancialAccountType,
  FinancialAccountNormalBalance,
  FinancialTransactionType,
  FinancialTransactionStatus,
  Prisma,
} from '@prisma/client';
import { BadRequestException, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { FinanceRepository } from '../src/finance/finance.repository.js';
import { FinanceService } from '../src/finance/finance.service.js';
import { AdminFinanceController } from '../src/finance/admin-finance.controller.js';
import { AuditService } from '../src/audit/audit.service.js';
import { PermissionsService, type MinimalUser } from '../src/permissions/permissions.service.js';
import { Permissions, UserRole } from '@vishkaraa/types';
import { ACCOUNT_CODES } from '../src/finance/finance.constants.js';

describe('Phase 15A: Financial Ledger Foundation & Concurrency Suite', () => {
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
  let auditLogsCreated: any[] = [];
  let testActorId: string;
  let cashAccountId: string;
  let salesAccountId: string;
  let taxAccountId: string;
  let clearingAccountId: string;

  beforeAll(async () => {
    await prisma.$connect();

    // Setup mock audit service that tracks events
    auditLogsCreated = [];
    const mockAuditService = {
      logEvent: async (params: any) => {
        auditLogsCreated.push(params);
        try {
          // Also persist real audit log if table exists
          await prisma.auditLog.create({
            data: {
              actorId: params.actorId,
              actorRole: params.actorRole,
              action: params.action,
              entityType: params.entityType,
              entityId: params.entityId,
              amount: params.amount,
              currency: params.currency,
            },
          });
        } catch {
          // Ignore audit write error in test
        }
      },
    } as unknown as AuditService;

    financeRepo = new FinanceRepository(prisma as any);
    financeService = new FinanceService(financeRepo, mockAuditService);

    // Retrieve seeded system accounts
    const cashAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.CASH_AND_BANK } });
    const salesAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.SALES_REVENUE } });
    const taxAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.GST_TAX_PAYABLE } });
    const clearingAcc = await prisma.financialAccount.findUnique({ where: { code: ACCOUNT_CODES.PAYMENT_GATEWAY_CLEARING } });

    expect(cashAcc).toBeDefined();
    expect(salesAcc).toBeDefined();
    expect(taxAcc).toBeDefined();
    expect(clearingAcc).toBeDefined();

    cashAccountId = cashAcc!.id;
    salesAccountId = salesAcc!.id;
    taxAccountId = taxAcc!.id;
    clearingAccountId = clearingAcc!.id;

    // Create a test user for actorId
    const testUser = await prisma.user.create({
      data: {
        email: `finance-test-${Date.now()}@vishkaraa.local`,
        passwordHash: 'dummy-hash',
        firstName: 'Finance',
        lastName: 'Admin',
        role: 'ADMIN',
      },
    });
    testActorId = testUser.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // 1. Account Management
  // ---------------------------------------------------------------------------
  describe('1. Account Management', () => {
    it('creates a new active financial account', async () => {
      const code = `TEST_ACC_${Date.now().toString().slice(-6)}`;
      const acc = await financeService.createAccount(
        {
          code,
          name: 'Test Clearing Account',
          type: FinancialAccountType.ASSET,
          normalBalance: FinancialAccountNormalBalance.DEBIT,
          description: 'Temporary asset account for testing',
        },
        testActorId,
      );

      expect(acc).toBeDefined();
      expect(acc.code).toBe(code);
      expect(acc.isActive).toBe(true);
      expect(acc.isSystemAccount).toBe(false);

      const auditEvent = auditLogsCreated.find(
        (a) => a.action === 'FINANCE_ACCOUNT_CREATED' && a.entityId === acc.id,
      );
      expect(auditEvent).toBeDefined();
    });

    it('rejects duplicate account code with ConflictException', async () => {
      const code = `DUP_${Date.now().toString().slice(-6)}`;
      await financeService.createAccount(
        {
          code,
          name: 'First Account',
          type: FinancialAccountType.EXPENSE,
          normalBalance: FinancialAccountNormalBalance.DEBIT,
        },
        testActorId,
      );

      await expect(
        financeService.createAccount(
          {
            code,
            name: 'Second Account with Duplicate Code',
            type: FinancialAccountType.EXPENSE,
            normalBalance: FinancialAccountNormalBalance.DEBIT,
          },
          testActorId,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('activates and deactivates an account safely', async () => {
      const code = `TOGGLE_${Date.now().toString().slice(-6)}`;
      const acc = await financeService.createAccount(
        {
          code,
          name: 'Toggle Test Account',
          type: FinancialAccountType.LIABILITY,
          normalBalance: FinancialAccountNormalBalance.CREDIT,
        },
        testActorId,
      );

      const deactivated = await financeService.deactivateAccount(acc.id, testActorId);
      expect(deactivated.isActive).toBe(false);

      // Posting against an inactive account must fail
      await expect(
        financeService.postTransaction(
          {
            transactionType: FinancialTransactionType.ADJUSTMENT,
            description: 'Post against inactive',
            idempotencyKey: `inactive_test_${Date.now()}`,
            lines: [
              { accountId: acc.id, debitPaise: 1000, creditPaise: 0 },
              { accountId: cashAccountId, debitPaise: 0, creditPaise: 1000 },
            ],
          },
          testActorId,
        ),
      ).rejects.toThrow(BadRequestException);

      const reactivated = await financeService.reactivateAccount(acc.id, testActorId);
      expect(reactivated.isActive).toBe(true);
    });

    it('prevents deleting an account referenced by transaction lines (FK RESTRICT)', async () => {
      const code = `REF_${Date.now().toString().slice(-6)}`;
      const acc = await financeService.createAccount(
        {
          code,
          name: 'Referenced Account',
          type: FinancialAccountType.EXPENSE,
          normalBalance: FinancialAccountNormalBalance.DEBIT,
        },
        testActorId,
      );

      // Post a transaction referencing this account
      await financeService.postTransaction(
        {
          transactionType: FinancialTransactionType.EXPENSE,
          description: 'Expense referencing account',
          idempotencyKey: `fk_test_${Date.now()}`,
          lines: [
            { accountId: acc.id, debitPaise: 5000, creditPaise: 0 },
            { accountId: cashAccountId, debitPaise: 0, creditPaise: 5000 },
          ],
        },
        testActorId,
      );

      // Attempt DB delete directly -> must be rejected by PostgreSQL foreign key RESTRICT constraint
      await expect(
        prisma.financialAccount.delete({
          where: { id: acc.id },
        }),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Accounting Invariants & Double-Entry Verification
  // ---------------------------------------------------------------------------
  describe('2. Accounting Invariants', () => {
    it('successfully posts a valid balanced transaction', async () => {
      const idempotencyKey = `tx_valid_${Date.now()}`;
      const tx = await financeService.postTransaction(
        {
          transactionType: FinancialTransactionType.SALE,
          currency: 'INR',
          sourceType: 'ORDER',
          sourceId: 'order-uuid-12345',
          description: 'Product sale with tax',
          idempotencyKey,
          lines: [
            { accountId: cashAccountId, debitPaise: 11800, creditPaise: 0, description: 'Cash collected' },
            { accountId: salesAccountId, debitPaise: 0, creditPaise: 10000, description: 'Revenue' },
            { accountId: taxAccountId, debitPaise: 0, creditPaise: 1800, description: '18% GST' },
          ],
        },
        testActorId,
      );

      expect(tx).toBeDefined();
      expect(tx.status).toBe(FinancialTransactionStatus.POSTED);
      expect(tx.postedAt).toBeInstanceOf(Date);
      expect(tx.lines).toHaveLength(3);

      const totalDebit = tx.lines.reduce((s, l) => s + l.debitPaise, 0);
      const totalCredit = tx.lines.reduce((s, l) => s + l.creditPaise, 0);
      expect(totalDebit).toBe(11800);
      expect(totalCredit).toBe(11800);
      expect(totalDebit).toBe(totalCredit);
    });

    it('rejects an unbalanced transaction and does not write partial records', async () => {
      const idempotencyKey = `unbalanced_${Date.now()}`;
      await expect(
        financeService.postTransaction(
          {
            transactionType: FinancialTransactionType.SALE,
            description: 'Unbalanced sale',
            idempotencyKey,
            lines: [
              { accountId: cashAccountId, debitPaise: 10000, creditPaise: 0 },
              { accountId: salesAccountId, debitPaise: 0, creditPaise: 8000 }, // Off by 2000 paise
            ],
          },
          testActorId,
        ),
      ).rejects.toThrow(BadRequestException);

      // Verify no transaction or lines were written
      const found = await prisma.financialTransaction.findUnique({
        where: { idempotencyKey },
      });
      expect(found).toBeNull();
    });

    it('rejects transactions with fewer than 2 lines', async () => {
      await expect(
        financeService.postTransaction(
          {
            transactionType: FinancialTransactionType.ADJUSTMENT,
            description: 'Single line',
            idempotencyKey: `single_line_${Date.now()}`,
            lines: [{ accountId: cashAccountId, debitPaise: 1000, creditPaise: 0 }],
          },
          testActorId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects lines having both debit and credit amounts', async () => {
      await expect(
        financeService.postTransaction(
          {
            transactionType: FinancialTransactionType.ADJUSTMENT,
            description: 'Both sides on same line',
            idempotencyKey: `both_sides_${Date.now()}`,
            lines: [
              { accountId: cashAccountId, debitPaise: 1000, creditPaise: 500 },
              { accountId: salesAccountId, debitPaise: 0, creditPaise: 500 },
            ],
          },
          testActorId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects lines having both debit and credit equal to zero', async () => {
      await expect(
        financeService.postTransaction(
          {
            transactionType: FinancialTransactionType.ADJUSTMENT,
            description: 'Zero line',
            idempotencyKey: `zero_line_${Date.now()}`,
            lines: [
              { accountId: cashAccountId, debitPaise: 0, creditPaise: 0 },
              { accountId: salesAccountId, debitPaise: 0, creditPaise: 0 },
            ],
          },
          testActorId,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Idempotency & Immutability
  // ---------------------------------------------------------------------------
  describe('3. Idempotency & Immutability', () => {
    it('returns the existing transaction idempotently on repeated submissions', async () => {
      const idempotencyKey = `idempotency_test_${Date.now()}`;
      const payload = {
        transactionType: FinancialTransactionType.PAYMENT,
        description: 'Payment gateway capture',
        idempotencyKey,
        lines: [
          { accountId: clearingAccountId, debitPaise: 50000, creditPaise: 0 },
          { accountId: salesAccountId, debitPaise: 0, creditPaise: 50000 },
        ],
      };

      const first = await financeService.postTransaction(payload, testActorId);
      const second = await financeService.postTransaction(payload, testActorId);

      expect(first.id).toBe(second.id);
      expect(first.lines.length).toBe(second.lines.length);

      // Verify only 1 record exists in database
      const count = await prisma.financialTransaction.count({
        where: { idempotencyKey },
      });
      expect(count).toBe(1);
    });

    it('allows reversing an immutable posted transaction via compensating transaction', async () => {
      const originalKey = `orig_tx_${Date.now()}`;
      const original = await financeService.postTransaction(
        {
          transactionType: FinancialTransactionType.SALE,
          description: 'Original sale to be reversed',
          idempotencyKey: originalKey,
          lines: [
            { accountId: cashAccountId, debitPaise: 25000, creditPaise: 0 },
            { accountId: salesAccountId, debitPaise: 0, creditPaise: 25000 },
          ],
        },
        testActorId,
      );

      const compensationKey = `reversal_${Date.now()}`;
      const reversed = await financeService.createCompensatingTransaction(
        original.id,
        {
          reason: 'Customer cancelled before fulfillment',
          idempotencyKey: compensationKey,
        },
        testActorId,
      );

      expect(reversed).toBeDefined();
      expect(reversed.id).not.toBe(original.id);
      expect(reversed.sourceId).toBe(original.id);

      // Lines must be inverted
      const cashLine = reversed.lines.find((l) => l.accountId === cashAccountId);
      const salesLine = reversed.lines.find((l) => l.accountId === salesAccountId);

      expect(cashLine?.creditPaise).toBe(25000);
      expect(cashLine?.debitPaise).toBe(0);
      expect(salesLine?.debitPaise).toBe(25000);
      expect(salesLine?.creditPaise).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Balances & Reporting Primitives
  // ---------------------------------------------------------------------------
  describe('4. Balances & Reporting Primitives', () => {
    it('computes account balance respecting normalBalance convention', async () => {
      // Cash is an ASSET with normalBalance = DEBIT (Balance = Debit - Credit)
      const cashBalance = await financeService.getAccountBalance(cashAccountId);
      expect(cashBalance.account.normalBalance).toBe('DEBIT');
      expect(cashBalance.balancePaise).toBe(cashBalance.totalDebitPaise - cashBalance.totalCreditPaise);

      // Sales is a REVENUE with normalBalance = CREDIT (Balance = Credit - Debit)
      const salesBalance = await financeService.getAccountBalance(salesAccountId);
      expect(salesBalance.account.normalBalance).toBe('CREDIT');
      expect(salesBalance.balancePaise).toBe(salesBalance.totalCreditPaise - salesBalance.totalDebitPaise);
    });

    it('computes trial balance where sum of all debits equals sum of all credits', async () => {
      const trialBalance = await financeService.getTrialBalance();
      expect(trialBalance).toBeDefined();
      expect(trialBalance.isBalanced).toBe(true);
      expect(trialBalance.totalDebitPaise).toBe(trialBalance.totalCreditPaise);
      expect(trialBalance.accounts.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Concurrency Suite (Real PostgreSQL)
  // ---------------------------------------------------------------------------
  describe('5. Real PostgreSQL Concurrency Suite', () => {
    it('Scenario 1: simultaneous identical postings result in exactly 1 transaction (idempotency race safety)', async () => {
      const idempotencyKey = `concurrency_race_${Date.now()}`;
      const payload = {
        transactionType: FinancialTransactionType.SALE,
        description: 'Concurrent race test',
        idempotencyKey,
        lines: [
          { accountId: cashAccountId, debitPaise: 75000, creditPaise: 0 },
          { accountId: salesAccountId, debitPaise: 0, creditPaise: 75000 },
        ],
      };

      // Launch 5 parallel requests with identical idempotencyKey
      const results = await Promise.all([
        financeService.postTransaction(payload, testActorId),
        financeService.postTransaction(payload, testActorId),
        financeService.postTransaction(payload, testActorId),
        financeService.postTransaction(payload, testActorId),
        financeService.postTransaction(payload, testActorId),
      ]);

      const firstId = results[0].id;
      for (const res of results) {
        expect(res.id).toBe(firstId);
      }

      const count = await prisma.financialTransaction.count({
        where: { idempotencyKey },
      });
      expect(count).toBe(1);
    });

    it('Scenario 2: simultaneous different valid postings all succeed and ledger remains balanced', async () => {
      const baseKey = `concurrent_multi_${Date.now()}`;
      const amounts = [10000, 20000, 30000, 40000];

      const promises = amounts.map((amt, idx) =>
        financeService.postTransaction(
          {
            transactionType: FinancialTransactionType.SALE,
            description: `Concurrent valid posting ${idx}`,
            idempotencyKey: `${baseKey}_${idx}`,
            lines: [
              { accountId: cashAccountId, debitPaise: amt, creditPaise: 0 },
              { accountId: salesAccountId, debitPaise: 0, creditPaise: amt },
            ],
          },
          testActorId,
        ),
      );

      const results = await Promise.all(promises);
      expect(results).toHaveLength(4);

      // Verify trial balance remains balanced
      const trialBalance = await financeService.getTrialBalance();
      expect(trialBalance.isBalanced).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Permission & Security Boundary Isolation
  // ---------------------------------------------------------------------------
  describe('6. Permission Isolation', () => {
    it('verifies that PermissionsService enforces FINANCE permissions correctly', async () => {
      const permissionsService = new PermissionsService(prisma as any, { logSecurityEvent: vi.fn(), logEvent: vi.fn() } as any);

      const userActor: MinimalUser = {
        id: 'regular-user-id',
        role: UserRole.USER,
        email: 'user@vishkaraa.local',
      };

      const adminActorWithoutFinance: MinimalUser = {
        id: 'admin-unauth-id',
        role: UserRole.ADMIN,
        email: 'admin-unauth@vishkaraa.local',
      };

      const superAdminActor: MinimalUser = {
        id: 'super-admin-id',
        role: UserRole.SUPER_ADMIN,
        email: 'superadmin@vishkaraa.local',
      };

      // 1. Regular USER cannot view or post finance
      const userCanView = await permissionsService.can(userActor, Permissions.FINANCE_VIEW);
      const userCanPost = await permissionsService.can(userActor, Permissions.FINANCE_POST);
      expect(userCanView).toBe(false);
      expect(userCanPost).toBe(false);

      // 2. ADMIN without explicit finance grant cannot view or post finance
      const adminCanView = await permissionsService.can(adminActorWithoutFinance, Permissions.FINANCE_VIEW);
      const adminCanPost = await permissionsService.can(adminActorWithoutFinance, Permissions.FINANCE_POST);
      expect(adminCanView).toBe(false);
      expect(adminCanPost).toBe(false);

      // 3. SUPER_ADMIN has platform wildcard access
      const superCanView = await permissionsService.can(superAdminActor, Permissions.FINANCE_VIEW);
      const superCanPost = await permissionsService.can(superAdminActor, Permissions.FINANCE_POST);
      const superCanManage = await permissionsService.can(superAdminActor, Permissions.FINANCE_MANAGE);
      expect(superCanView).toBe(true);
      expect(superCanPost).toBe(true);
      expect(superCanManage).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Admin Finance Controller Endpoints
  // ---------------------------------------------------------------------------
  describe('7. AdminFinanceController Endpoints', () => {
    let controller: AdminFinanceController;

    beforeAll(() => {
      controller = new AdminFinanceController(financeService);
    });

    it('lists accounts via controller', async () => {
      const res = await controller.listAccounts('true');
      expect(Array.isArray(res)).toBe(true);
      expect(res.length).toBeGreaterThan(0);
    });

    it('gets an account by id and account balance via controller', async () => {
      const acc = await controller.getAccount(cashAccountId);
      expect(acc.id).toBe(cashAccountId);

      const bal = await controller.getAccountBalance(cashAccountId);
      expect(bal.account.id).toBe(cashAccountId);
      expect(bal.totalDebitPaise).toBeGreaterThan(0);
    });

    it('posts transaction via controller', async () => {
      const mockReq = { user: { id: testActorId, role: 'ADMIN', email: 'admin@vishkaraa.local' } } as any;
      const tx = await controller.postTransaction(
        {
          transactionType: FinancialTransactionType.SALE,
          description: 'Controller posting test',
          idempotencyKey: `controller_tx_${Date.now()}`,
          lines: [
            { accountId: cashAccountId, debitPaise: 5000, creditPaise: 0 },
            { accountId: salesAccountId, debitPaise: 0, creditPaise: 5000 },
          ],
        },
        mockReq,
      );
      expect(tx.status).toBe(FinancialTransactionStatus.POSTED);
    });

    it('creates compensating transaction via controller', async () => {
      const mockReq = { user: { id: testActorId, role: 'ADMIN', email: 'admin@vishkaraa.local' } } as any;
      const tx = await controller.postTransaction(
        {
          transactionType: FinancialTransactionType.SALE,
          description: 'Controller compensate target',
          idempotencyKey: `controller_target_${Date.now()}`,
          lines: [
            { accountId: cashAccountId, debitPaise: 3000, creditPaise: 0 },
            { accountId: salesAccountId, debitPaise: 0, creditPaise: 3000 },
          ],
        },
        mockReq,
      );

      const comp = await controller.compensateTransaction(
        tx.id,
        { reason: 'Customer requested refund', idempotencyKey: `controller_comp_${Date.now()}` },
        mockReq,
      );
      expect(comp.sourceId).toBe(tx.id);
    });

    it('gets trial balance via controller', async () => {
      const tb = await controller.getTrialBalance();
      expect(tb.isBalanced).toBe(true);
    });
  });
});

