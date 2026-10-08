import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  FinancialTransactionType,
  FinancialTransactionStatus,
  OrderStatus,
  PaymentStatus,
  RefundStatus,
  RefundAttemptStatus,
  RefundSource,
  RefundType,
  CheckoutStatus,
  Prisma,
} from '@prisma/client';
import { FinanceRepository } from '../src/finance/finance.repository.js';
import { FinanceService } from '../src/finance/finance.service.js';
import { OrderService } from '../src/orders/orders.service.js';
import { PaymentService } from '../src/payment/payment.service.js';
import { RefundService } from '../src/refunds/refund.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { FeaturesService } from '../src/features/features.service.js';
import { CheckoutService } from '../src/checkout/checkout.service.js';
import { EntityOwnershipService } from '../src/common/services/entity-ownership.service.js';
import { MockPaymentProvider } from '../src/payment/providers/mock-payment.provider.js';
import { ACCOUNT_CODES } from '../src/finance/finance.constants.js';

describe('Phase 15B: Financial Integration with Business Domains & Concurrency Suite', () => {
  const testDbUrl =
    process.env['DATABASE_URL_TEST'] ||
    process.env['DATABASE_URL'] ||
    'postgresql://postgres:Hari@950@localhost:5432/vishkaraa_test?schema=public';

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: testDbUrl,
      },
    },
  });

  let financeRepo: FinanceRepository;
  let financeService: FinanceService;
  let auditService: AuditService;
  let paymentService: PaymentService;
  let refundService: RefundService;

  let testUserId: string;
  let testAdminId: string;
  let cashAccountId: string;
  let salesAccountId: string;
  let arAccountId: string;
  let clearingAccountId: string;
  let refundAccountId: string;
  let taxAccountId: string;

  beforeAll(async () => {
    await prisma.$connect();

    auditService = new AuditService(prisma as any);
    financeRepo = new FinanceRepository(prisma as any);
    financeService = new FinanceService(financeRepo, auditService);

    // Setup domain services for payment and refund testing
    const featuresService = new FeaturesService(prisma as any);
    const ownershipService = new EntityOwnershipService(prisma as any);
    const mockProvider = new MockPaymentProvider();

    paymentService = new PaymentService(
      prisma as any,
      auditService,
      featuresService,
      {} as any, // checkoutService not used directly in transitionStatusSystem
      ownershipService,
      mockProvider,
      undefined,
      financeService,
    );

    refundService = new RefundService(
      prisma as any,
      auditService,
      mockProvider,
      undefined,
      financeService,
    );

    // Retrieve system accounts
    const [cash, sales, ar, clearing, refunds, tax] = await Promise.all([
      prisma.financialAccount.findUniqueOrThrow({ where: { code: ACCOUNT_CODES.CASH_AND_BANK } }),
      prisma.financialAccount.findUniqueOrThrow({ where: { code: ACCOUNT_CODES.SALES_REVENUE } }),
      prisma.financialAccount.findUniqueOrThrow({ where: { code: ACCOUNT_CODES.ACCOUNTS_RECEIVABLE } }),
      prisma.financialAccount.findUniqueOrThrow({ where: { code: ACCOUNT_CODES.PAYMENT_GATEWAY_CLEARING } }),
      prisma.financialAccount.findUniqueOrThrow({ where: { code: ACCOUNT_CODES.REFUNDS_ISSUED } }),
      prisma.financialAccount.findUniqueOrThrow({ where: { code: ACCOUNT_CODES.GST_TAX_PAYABLE } }),
    ]);

    cashAccountId = cash.id;
    salesAccountId = sales.id;
    arAccountId = ar.id;
    clearingAccountId = clearing.id;
    refundAccountId = refunds.id;
    taxAccountId = tax.id;

    // Create test user and admin
    const timestamp = Date.now();
    const user = await prisma.user.create({
      data: {
        email: `fin15b_user_${timestamp}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'FinUser',
        lastName: 'Test',
        role: 'USER',
      },
    });
    testUserId = user.id;

    const admin = await prisma.user.create({
      data: {
        email: `fin15b_admin_${timestamp}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'FinAdmin',
        lastName: 'Test',
        role: 'ADMIN',
      },
    });
    testAdminId = admin.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // 1. Order / Sale Integration
  // ---------------------------------------------------------------------------
  describe('1. Order / Sale Recognition Integration', () => {
    it('creates exactly one balanced SALE financial transaction for a confirmed order', async () => {
      const orderId = `test_order_${Date.now()}`;
      const totalAmount = 11800; // ₹118.00
      const subtotal = 10000;    // ₹100.00
      const tax = 1800;          // ₹18.00 (18% GST)

      const tx = await prisma.$transaction(async (txClient) => {
        return financeService.postOrderSaleInTransaction(
          {
            id: orderId,
            totalAmount,
            subtotal,
            tax,
            currency: 'INR',
          },
          txClient,
          testUserId,
        );
      });

      expect(tx).toBeDefined();
      expect(tx.status).toBe(FinancialTransactionStatus.POSTED);
      expect(tx.transactionType).toBe(FinancialTransactionType.SALE);
      expect(tx.sourceType).toBe('ORDER');
      expect(tx.sourceId).toBe(orderId);
      expect(tx.idempotencyKey).toBe(`sale_order_${orderId}`);

      // Verify lines: Dr AR (11800), Cr Revenue (10000), Cr Tax (1800)
      expect(tx.lines).toHaveLength(3);

      const arLine = tx.lines.find((l) => l.accountId === arAccountId);
      const revLine = tx.lines.find((l) => l.accountId === salesAccountId);
      const taxLine = tx.lines.find((l) => l.accountId === taxAccountId);

      expect(arLine?.debitPaise).toBe(11800);
      expect(arLine?.creditPaise).toBe(0);

      expect(revLine?.debitPaise).toBe(0);
      expect(revLine?.creditPaise).toBe(10000);

      expect(taxLine?.debitPaise).toBe(0);
      expect(taxLine?.creditPaise).toBe(1800);

      const totalDebit = tx.lines.reduce((s, l) => s + l.debitPaise, 0);
      const totalCredit = tx.lines.reduce((s, l) => s + l.creditPaise, 0);
      expect(totalDebit).toBe(totalCredit);
      expect(totalDebit).toBe(11800);
    });

    it('duplicate order finalization replay returns existing SALE transaction idempotently', async () => {
      const orderId = `test_order_replay_${Date.now()}`;
      const totalAmount = 50000;

      const first = await prisma.$transaction(async (txClient) => {
        return financeService.postOrderSaleInTransaction(
          { id: orderId, totalAmount, subtotal: totalAmount, tax: 0 },
          txClient,
          testUserId,
        );
      });

      const second = await prisma.$transaction(async (txClient) => {
        return financeService.postOrderSaleInTransaction(
          { id: orderId, totalAmount, subtotal: totalAmount, tax: 0 },
          txClient,
          testUserId,
        );
      });

      expect(first.id).toBe(second.id);

      const count = await prisma.financialTransaction.count({
        where: { idempotencyKey: `sale_order_${orderId}` },
      });
      expect(count).toBe(1);
    });

    it('rolls back completely if financial posting fails inside order finalization transaction', async () => {
      const orderId = `failed_order_${Date.now()}`;

      // Simulate a transaction where order is created but an invalid finance posting is attempted
      await expect(
        prisma.$transaction(async (txClient) => {
          // Attempting posting with non-existent account or invalid lines
          await financeService.postTransaction(
            {
              transactionType: FinancialTransactionType.SALE,
              description: 'Invalid posting inside order finalization',
              idempotencyKey: `invalid_${orderId}`,
              lines: [
                { accountId: arAccountId, debitPaise: 5000, creditPaise: 0 },
                { accountId: salesAccountId, debitPaise: 0, creditPaise: 4000 }, // Unbalanced!
              ],
            },
            testUserId,
          );
        }),
      ).rejects.toThrow();

      // Verify no financial transaction was committed
      const found = await prisma.financialTransaction.findUnique({
        where: { idempotencyKey: `invalid_${orderId}` },
      });
      expect(found).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Payment Integration
  // ---------------------------------------------------------------------------
  describe('2. Payment Capture Integration', () => {
    it('creates exactly one PAYMENT financial transaction upon payment capture', async () => {
      const attemptId = `pay_att_${Date.now()}`;
      const amount = 11800;

      const tx = await financeService.postPaymentCapture(
        {
          id: attemptId,
          amount,
          currency: 'INR',
          userId: testUserId,
        },
        undefined,
        testUserId,
      );

      expect(tx).toBeDefined();
      expect(tx.status).toBe(FinancialTransactionStatus.POSTED);
      expect(tx.transactionType).toBe(FinancialTransactionType.PAYMENT);
      expect(tx.sourceType).toBe('PAYMENT');
      expect(tx.sourceId).toBe(attemptId);
      expect(tx.idempotencyKey).toBe(`payment_${attemptId}`);

      // Dr Payment Gateway Clearing (11800), Cr Accounts Receivable (11800)
      expect(tx.lines).toHaveLength(2);
      const clearingLine = tx.lines.find((l) => l.accountId === clearingAccountId);
      const arLine = tx.lines.find((l) => l.accountId === arAccountId);

      expect(clearingLine?.debitPaise).toBe(11800);
      expect(clearingLine?.creditPaise).toBe(0);

      expect(arLine?.debitPaise).toBe(0);
      expect(arLine?.creditPaise).toBe(11800);
    });

    it('payment capture replay is deterministic and creates no duplicate ledger entries', async () => {
      const attemptId = `pay_replay_${Date.now()}`;
      const amount = 25000;

      const first = await financeService.postPaymentCapture(
        { id: attemptId, amount, currency: 'INR', userId: testUserId },
        undefined,
        testUserId,
      );

      const second = await financeService.postPaymentCapture(
        { id: attemptId, amount, currency: 'INR', userId: testUserId },
        undefined,
        testUserId,
      );

      expect(first.id).toBe(second.id);

      const count = await prisma.financialTransaction.count({
        where: { idempotencyKey: `payment_${attemptId}` },
      });
      expect(count).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Refund Integration
  // ---------------------------------------------------------------------------
  describe('3. Refund Completion Integration', () => {
    it('creates exactly one REFUND financial transaction upon completed refund', async () => {
      const refundId = `ref_comp_${Date.now()}`;
      const orderId = `ref_order_${Date.now()}`;
      const amount = 4000; // ₹40.00

      const tx = await prisma.$transaction(async (txClient) => {
        return financeService.postRefundCompletedInTransaction(
          {
            id: refundId,
            amount,
            orderId,
            currency: 'INR',
          },
          txClient,
          testAdminId,
        );
      });

      expect(tx).toBeDefined();
      expect(tx.status).toBe(FinancialTransactionStatus.POSTED);
      expect(tx.transactionType).toBe(FinancialTransactionType.REFUND);
      expect(tx.sourceType).toBe('REFUND');
      expect(tx.sourceId).toBe(refundId);
      expect(tx.idempotencyKey).toBe(`refund_${refundId}`);

      // Dr Refunds Issued (4000), Cr Payment Gateway Clearing (4000)
      expect(tx.lines).toHaveLength(2);
      const refundLine = tx.lines.find((l) => l.accountId === refundAccountId);
      const clearingLine = tx.lines.find((l) => l.accountId === clearingAccountId);

      expect(refundLine?.debitPaise).toBe(4000);
      expect(refundLine?.creditPaise).toBe(0);

      expect(clearingLine?.debitPaise).toBe(0);
      expect(clearingLine?.creditPaise).toBe(4000);
    });

    it('duplicate refund completion creates no duplicate ledger entries', async () => {
      const refundId = `ref_replay_${Date.now()}`;
      const orderId = `ref_order_replay_${Date.now()}`;
      const amount = 3000;

      const first = await prisma.$transaction(async (txClient) => {
        return financeService.postRefundCompletedInTransaction(
          { id: refundId, amount, orderId, currency: 'INR' },
          txClient,
          testAdminId,
        );
      });

      const second = await prisma.$transaction(async (txClient) => {
        return financeService.postRefundCompletedInTransaction(
          { id: refundId, amount, orderId, currency: 'INR' },
          txClient,
          testAdminId,
        );
      });

      expect(first.id).toBe(second.id);

      const count = await prisma.financialTransaction.count({
        where: { idempotencyKey: `refund_${refundId}` },
      });
      expect(count).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Double-Counting Prevention & Full Order Lifecycle
  // ---------------------------------------------------------------------------
  describe('4. Double-Counting Prevention & Full Order Lifecycle', () => {
    it('Order Confirmed (SALE) + Payment Captured (PAYMENT) + Refund (REFUND) preserves exact ledger balance', async () => {
      const lifecycleOrderId = `order_lifecycle_${Date.now()}`;
      const lifecyclePaymentId = `pay_lifecycle_${Date.now()}`;
      const lifecycleRefundId = `ref_lifecycle_${Date.now()}`;

      const orderAmount = 100000; // ₹1,000.00
      const refundAmount = 40000; // ₹400.00 partial refund

      // Step 1: Order Confirmed -> SALE transaction
      // Dr AR: 100000, Cr Revenue: 100000
      const saleTx = await prisma.$transaction(async (txClient) => {
        return financeService.postOrderSaleInTransaction(
          {
            id: lifecycleOrderId,
            totalAmount: orderAmount,
            subtotal: orderAmount,
            tax: 0,
            currency: 'INR',
          },
          txClient,
          testUserId,
        );
      });
      expect(saleTx.transactionType).toBe(FinancialTransactionType.SALE);

      // Step 2: Payment Captured -> PAYMENT transaction
      // Dr Gateway Clearing: 100000, Cr AR: 100000
      const payTx = await financeService.postPaymentCapture(
        {
          id: lifecyclePaymentId,
          amount: orderAmount,
          currency: 'INR',
          userId: testUserId,
        },
        undefined,
        testUserId,
      );
      expect(payTx.transactionType).toBe(FinancialTransactionType.PAYMENT);

      // Verify AR lines: sale debited AR by 100000; payment credited AR by 100000
      const saleArLine = saleTx.lines.find((l) => l.accountId === arAccountId);
      const payArLine = payTx.lines.find((l) => l.accountId === arAccountId);
      expect(saleArLine?.debitPaise).toBe(orderAmount);
      expect(payArLine?.creditPaise).toBe(orderAmount);

      // Step 3: Partial Refund Completed -> REFUND transaction
      // Dr Refunds Issued: 40000, Cr Gateway Clearing: 40000
      const refTx = await prisma.$transaction(async (txClient) => {
        return financeService.postRefundCompletedInTransaction(
          {
            id: lifecycleRefundId,
            amount: refundAmount,
            orderId: lifecycleOrderId,
            currency: 'INR',
          },
          txClient,
          testAdminId,
        );
      });
      expect(refTx.transactionType).toBe(FinancialTransactionType.REFUND);

      // Step 4: Verify Final Trial Balance
      const trialBalance = await financeService.getTrialBalance();
      expect(trialBalance.isBalanced).toBe(true);
      expect(trialBalance.totalDebitPaise).toBe(trialBalance.totalCreditPaise);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Concurrency Testing (Real PostgreSQL)
  // ---------------------------------------------------------------------------
  describe('5. Real PostgreSQL Domain Concurrency Suite', () => {
    it('concurrent duplicate order finalization attempts result in exactly 1 SALE ledger record', async () => {
      const orderId = `concurrent_order_${Date.now()}`;
      const totalAmount = 88000;

      const results = await Promise.all([
        financeService.postOrderSaleInTransaction(
          { id: orderId, totalAmount, subtotal: totalAmount, tax: 0 },
          undefined,
          testUserId,
        ),
        financeService.postOrderSaleInTransaction(
          { id: orderId, totalAmount, subtotal: totalAmount, tax: 0 },
          undefined,
          testUserId,
        ),
        financeService.postOrderSaleInTransaction(
          { id: orderId, totalAmount, subtotal: totalAmount, tax: 0 },
          undefined,
          testUserId,
        ),
      ]);

      const firstId = results[0].id;
      for (const res of results) {
        expect(res.id).toBe(firstId);
      }

      const count = await prisma.financialTransaction.count({
        where: { idempotencyKey: `sale_order_${orderId}` },
      });
      expect(count).toBe(1);
    });

    it('concurrent duplicate payment capture attempts result in exactly 1 PAYMENT ledger record', async () => {
      const attemptId = `concurrent_pay_${Date.now()}`;
      const amount = 65000;

      const results = await Promise.all([
        financeService.postPaymentCapture({ id: attemptId, amount, currency: 'INR' }, undefined, testUserId),
        financeService.postPaymentCapture({ id: attemptId, amount, currency: 'INR' }, undefined, testUserId),
        financeService.postPaymentCapture({ id: attemptId, amount, currency: 'INR' }, undefined, testUserId),
      ]);

      const firstId = results[0].id;
      for (const res of results) {
        expect(res.id).toBe(firstId);
      }

      const count = await prisma.financialTransaction.count({
        where: { idempotencyKey: `payment_${attemptId}` },
      });
      expect(count).toBe(1);
    });

    it('concurrent duplicate refund completion attempts result in exactly 1 REFUND ledger record', async () => {
      const refundId = `concurrent_ref_${Date.now()}`;
      const orderId = `concurrent_order_ref_${Date.now()}`;
      const amount = 15000;

      const results = await Promise.all([
        financeService.postRefundCompletedInTransaction(
          { id: refundId, amount, orderId, currency: 'INR' },
          undefined,
          testAdminId,
        ),
        financeService.postRefundCompletedInTransaction(
          { id: refundId, amount, orderId, currency: 'INR' },
          undefined,
          testAdminId,
        ),
        financeService.postRefundCompletedInTransaction(
          { id: refundId, amount, orderId, currency: 'INR' },
          undefined,
          testAdminId,
        ),
      ]);

      const firstId = results[0].id;
      for (const res of results) {
        expect(res.id).toBe(firstId);
      }

      const count = await prisma.financialTransaction.count({
        where: { idempotencyKey: `refund_${refundId}` },
      });
      expect(count).toBe(1);
    });
  });
});
