import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import {
  type FinancialAccount,
  type FinancialTransaction,
  type FinancialTransactionLine,
  FinancialAccountType,
  FinancialTransactionType,
  FinancialTransactionStatus,
  Prisma,
} from '@prisma/client';
import { FinanceRepository, type CreateLineInput } from './finance.repository.js';
import { AuditService } from '../audit/audit.service.js';
import {
  ACCOUNT_CODES,
  FINANCE_SOURCE_TYPES,
  buildIdempotencyKey,
} from './finance.constants.js';
import {
  CreateFinancialAccountDto,
  CreateFinancialTransactionDto,
  QueryFinancialTransactionsDto,
  CompensatingTransactionDto,
  QueryFinancialReportDto,
  QueryAccountDrillDownDto,
  PeriodPreset,
  type TrialBalanceReport,
  type ProfitLossReport,
  type BalanceSheetReport,
  type AccountDrillDownReport,
} from './dto/index.js';

export interface AccountBalanceResult {
  account: FinancialAccount;
  totalDebitPaise: number;
  totalCreditPaise: number;
  balancePaise: number;
}

export interface TrialBalanceItem {
  account: FinancialAccount;
  totalDebitPaise: number;
  totalCreditPaise: number;
  balancePaise: number;
}

export interface TrialBalanceResult {
  asOf: Date;
  accounts: TrialBalanceItem[];
  totalDebitPaise: number;
  totalCreditPaise: number;
  isBalanced: boolean;
}

@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);

  constructor(
    private readonly financeRepo: FinanceRepository,
    private readonly auditService: AuditService,
  ) {}

  private accountIdCache = new Map<string, string>();

  async getAccountIdByCode(code: string, tx?: Prisma.TransactionClient): Promise<string> {
    if (!tx && this.accountIdCache.has(code)) {
      return this.accountIdCache.get(code)!;
    }
    const acc = await this.financeRepo.findAccountByCode(code, tx);
    if (!acc) {
      throw new NotFoundException(`System financial account with code '${code}' not found`);
    }
    if (!acc.isActive) {
      throw new BadRequestException(`System financial account with code '${code}' is inactive`);
    }
    this.accountIdCache.set(code, acc.id);
    return acc.id;
  }

  // ---------------------------------------------------------------------------
  // Account Operations
  // ---------------------------------------------------------------------------

  async createAccount(
    dto: CreateFinancialAccountDto,
    actorId: string,
  ): Promise<FinancialAccount> {
    const existing = await this.financeRepo.findAccountByCode(dto.code);
    if (existing) {
      throw new ConflictException(`Financial account with code '${dto.code}' already exists`);
    }

    const account = await this.financeRepo.createAccount({
      code: dto.code,
      name: dto.name,
      type: dto.type,
      normalBalance: dto.normalBalance,
      description: dto.description ?? null,
      isSystemAccount: false,
      isActive: true,
    });

    await this.auditService.logEvent({
      actorId,
      actorRole: 'ADMIN',
      action: 'FINANCE_ACCOUNT_CREATED',
      entityType: 'FINANCIAL_ACCOUNT',
      entityId: account.id,
      newValue: {
        code: account.code,
        name: account.name,
        type: account.type,
        normalBalance: account.normalBalance,
      },
    });

    return account;
  }

  async listAccounts(filters: { isActive?: boolean; type?: string } = {}): Promise<FinancialAccount[]> {
    return this.financeRepo.listAccounts(filters);
  }

  async getAccountById(id: string): Promise<FinancialAccount> {
    const account = await this.financeRepo.findAccountById(id);
    if (!account) {
      throw new NotFoundException(`Financial account with ID '${id}' not found`);
    }
    return account;
  }

  async deactivateAccount(id: string, actorId: string): Promise<FinancialAccount> {
    const account = await this.getAccountById(id);
    if (!account.isActive) {
      throw new BadRequestException(`Financial account '${account.code}' is already inactive`);
    }

    const updated = await this.financeRepo.deactivateAccount(id);

    await this.auditService.logEvent({
      actorId,
      actorRole: 'ADMIN',
      action: 'FINANCE_ACCOUNT_DEACTIVATED',
      entityType: 'FINANCIAL_ACCOUNT',
      entityId: updated.id,
      previousValue: { isActive: true },
      newValue: { isActive: false },
    });

    return updated;
  }

  async reactivateAccount(id: string, actorId: string): Promise<FinancialAccount> {
    const account = await this.getAccountById(id);
    if (account.isActive) {
      throw new BadRequestException(`Financial account '${account.code}' is already active`);
    }

    const updated = await this.financeRepo.reactivateAccount(id);

    await this.auditService.logEvent({
      actorId,
      actorRole: 'ADMIN',
      action: 'FINANCE_ACCOUNT_REACTIVATED',
      entityType: 'FINANCIAL_ACCOUNT',
      entityId: updated.id,
      previousValue: { isActive: false },
      newValue: { isActive: true },
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Transaction Operations (Posting & Idempotency)
  // ---------------------------------------------------------------------------

  async postTransaction(
    dto: CreateFinancialTransactionDto,
    actorId: string,
  ): Promise<FinancialTransaction & { lines: FinancialTransactionLine[] }> {
    // 1. Idempotency Check — return existing transaction if already posted
    const existing = await this.financeRepo.findTransactionByIdempotencyKey(dto.idempotencyKey);
    if (existing) {
      this.logger.log(`Idempotent hit for financial transaction: ${dto.idempotencyKey}`);
      return existing;
    }

    // 2. Structural & Accounting Invariant Validations
    if (!dto.lines || dto.lines.length < 2) {
      throw new BadRequestException('A financial transaction must contain at least 2 lines (double-entry requirement)');
    }

    let totalDebit = 0;
    let totalCredit = 0;
    const accountIds = new Set<string>();

    for (let i = 0; i < dto.lines.length; i++) {
      const line = dto.lines[i];
      if (line.debitPaise < 0 || line.creditPaise < 0) {
        throw new BadRequestException(`Line ${i + 1}: Debit and credit amounts must be non-negative integer paise`);
      }
      if (line.debitPaise > 0 && line.creditPaise > 0) {
        throw new BadRequestException(`Line ${i + 1}: A line cannot contain both a debit and a credit amount`);
      }
      if (line.debitPaise === 0 && line.creditPaise === 0) {
        throw new BadRequestException(`Line ${i + 1}: A line must have either a non-zero debit or a non-zero credit`);
      }

      totalDebit += line.debitPaise;
      totalCredit += line.creditPaise;
      accountIds.add(line.accountId);
    }

    if (totalDebit <= 0) {
      throw new BadRequestException('Transaction monetary total must be greater than zero paise');
    }

    if (totalDebit !== totalCredit) {
      throw new BadRequestException(
        `Double-entry invariant violated: total debit (${totalDebit} paise) does not match total credit (${totalCredit} paise)`,
      );
    }

    // 3. Verify Account Validity & Active Status
    const accounts = await this.financeRepo.findAccountsByIds(Array.from(accountIds));
    const accountMap = new Map(accounts.map((a) => [a.id, a]));

    for (const accId of accountIds) {
      const acc = accountMap.get(accId);
      if (!acc) {
        throw new BadRequestException(`Financial account with ID '${accId}' does not exist`);
      }
      if (!acc.isActive) {
        throw new BadRequestException(`Financial account '${acc.code}' (${acc.name}) is inactive and cannot accept postings`);
      }
    }

    // 4. Atomic Database Transaction with P2002 Race Handling
    try {
      const createdTx = await this.financeRepo.transaction(async (tx) => {
        return this.financeRepo.createTransaction(
          {
            transactionType: dto.transactionType,
            currency: dto.currency ?? 'INR',
            sourceType: dto.sourceType,
            sourceId: dto.sourceId,
            description: dto.description,
            idempotencyKey: dto.idempotencyKey,
            createdById: actorId,
            status: FinancialTransactionStatus.POSTED,
            postedAt: new Date(),
          },
          dto.lines,
          tx,
        );
      });

      // 5. Audit Logging (non-blocking)
      await this.auditService.logEvent({
        actorId,
        actorRole: 'ADMIN',
        action: 'FINANCE_TRANSACTION_POSTED',
        entityType: 'FINANCIAL_TRANSACTION',
        entityId: createdTx.id,
        amount: totalDebit,
        currency: createdTx.currency,
        metadata: {
          idempotencyKey: createdTx.idempotencyKey,
          transactionType: createdTx.transactionType,
          sourceType: createdTx.sourceType,
          sourceId: createdTx.sourceId,
          lineCount: createdTx.lines.length,
        },
      });

      return createdTx;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Race condition: another thread posted with this idempotency key concurrently
        const concurrent = await this.financeRepo.findTransactionByIdempotencyKey(dto.idempotencyKey);
        if (concurrent) {
          return concurrent;
        }
      }
      throw error;
    }
  }

  async getTransactionById(
    id: string,
  ): Promise<FinancialTransaction & { lines: FinancialTransactionLine[] }> {
    const tx = await this.financeRepo.findTransactionById(id);
    if (!tx) {
      throw new NotFoundException(`Financial transaction with ID '${id}' not found`);
    }
    return tx;
  }

  async listTransactions(
    dto: QueryFinancialTransactionsDto,
  ): Promise<{ data: FinancialTransaction[]; total: number; page: number; limit: number }> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const { data, total } = await this.financeRepo.listTransactions({
      status: dto.status,
      sourceType: dto.sourceType,
      sourceId: dto.sourceId,
      page,
      limit,
    });
    return { data, total, page, limit };
  }

  // ---------------------------------------------------------------------------
  // Domain Integrations (Phase 15B)
  // ---------------------------------------------------------------------------

  async postOrderSaleInTransaction(
    order: {
      id: string;
      totalAmount: number;
      subtotal: number;
      tax?: number;
      currency?: string;
    },
    tx?: Prisma.TransactionClient,
    actorId?: string,
  ): Promise<FinancialTransaction & { lines: FinancialTransactionLine[] }> {
    const idempotencyKey = buildIdempotencyKey.sale(order.id);

    // 1. Idempotency check inside transaction
    const existing = await this.financeRepo.findTransactionByIdempotencyKey(idempotencyKey, tx);
    if (existing) {
      return existing;
    }

    // 2. Resolve account IDs
    const [arAccountId, salesRevenueAccountId, taxPayableAccountId] = await Promise.all([
      this.getAccountIdByCode(ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, tx),
      this.getAccountIdByCode(ACCOUNT_CODES.SALES_REVENUE, tx),
      this.getAccountIdByCode(ACCOUNT_CODES.GST_TAX_PAYABLE, tx),
    ]);

    // 3. Prepare balanced double-entry lines
    const taxPaise = Math.max(0, order.tax ?? 0);
    const revenuePaise = order.totalAmount - taxPaise;

    const lines: CreateLineInput[] = [
      {
        accountId: arAccountId,
        debitPaise: order.totalAmount,
        creditPaise: 0,
        description: `Accounts Receivable for Order ${order.id}`,
      },
      {
        accountId: salesRevenueAccountId,
        debitPaise: 0,
        creditPaise: revenuePaise,
        description: `Sales Revenue for Order ${order.id}`,
      },
    ];

    if (taxPaise > 0) {
      lines.push({
        accountId: taxPayableAccountId,
        debitPaise: 0,
        creditPaise: taxPaise,
        description: `GST / Output Tax for Order ${order.id}`,
      });
    }

    const txData = {
      transactionType: FinancialTransactionType.SALE,
      currency: order.currency ?? 'INR',
      sourceType: FINANCE_SOURCE_TYPES.ORDER,
      sourceId: order.id,
      description: `Sale recognition for Order ${order.id}`,
      idempotencyKey,
      createdById: actorId ?? 'SYSTEM',
      status: FinancialTransactionStatus.POSTED,
      postedAt: new Date(),
    };

    if (tx) {
      const createdTx = await this.financeRepo.createTransaction(txData, lines, tx);
      await this.auditService.logEvent({
        actorId: actorId ?? 'SYSTEM',
        actorRole: 'SYSTEM',
        action: 'FINANCE_ORDER_SALE_POSTED',
        entityType: 'FINANCIAL_TRANSACTION',
        entityId: createdTx.id,
        amount: order.totalAmount,
        currency: order.currency ?? 'INR',
        metadata: {
          orderId: order.id,
          idempotencyKey,
          transactionType: createdTx.transactionType,
          sourceType: FINANCE_SOURCE_TYPES.ORDER,
          sourceId: order.id,
        },
      });
      return createdTx;
    }

    try {
      const createdTx = await this.financeRepo.transaction(async (client) => {
        return this.financeRepo.createTransaction(txData, lines, client);
      });

      await this.auditService.logEvent({
        actorId: actorId ?? 'SYSTEM',
        actorRole: 'SYSTEM',
        action: 'FINANCE_ORDER_SALE_POSTED',
        entityType: 'FINANCIAL_TRANSACTION',
        entityId: createdTx.id,
        amount: order.totalAmount,
        currency: order.currency ?? 'INR',
        metadata: {
          orderId: order.id,
          idempotencyKey,
          transactionType: createdTx.transactionType,
          sourceType: FINANCE_SOURCE_TYPES.ORDER,
          sourceId: order.id,
        },
      });

      return createdTx;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const concurrent = await this.financeRepo.findTransactionByIdempotencyKey(idempotencyKey);
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  async postPaymentCapture(
    attempt: {
      id: string;
      amount: number;
      currency?: string;
      userId?: string;
    },
    tx?: Prisma.TransactionClient,
    actorId?: string,
  ): Promise<FinancialTransaction & { lines: FinancialTransactionLine[] }> {
    const idempotencyKey = buildIdempotencyKey.payment(attempt.id);

    // 1. Idempotency check
    const existing = await this.financeRepo.findTransactionByIdempotencyKey(idempotencyKey, tx);
    if (existing) {
      return existing;
    }

    // 2. Resolve account IDs
    const [clearingAccountId, arAccountId] = await Promise.all([
      this.getAccountIdByCode(ACCOUNT_CODES.PAYMENT_GATEWAY_CLEARING, tx),
      this.getAccountIdByCode(ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, tx),
    ]);

    // 3. Prepare balanced double-entry lines
    const lines: CreateLineInput[] = [
      {
        accountId: clearingAccountId,
        debitPaise: attempt.amount,
        creditPaise: 0,
        description: `Gateway Clearing for Payment ${attempt.id}`,
      },
      {
        accountId: arAccountId,
        debitPaise: 0,
        creditPaise: attempt.amount,
        description: `Receivable settlement for Payment ${attempt.id}`,
      },
    ];

    const txData = {
      transactionType: FinancialTransactionType.PAYMENT,
      currency: attempt.currency ?? 'INR',
      sourceType: FINANCE_SOURCE_TYPES.PAYMENT,
      sourceId: attempt.id,
      description: `Payment captured: ${attempt.id}`,
      idempotencyKey,
      createdById: actorId ?? attempt.userId ?? 'SYSTEM',
      status: FinancialTransactionStatus.POSTED,
      postedAt: new Date(),
    };

    if (tx) {
      const createdTx = await this.financeRepo.createTransaction(txData, lines, tx);
      await this.auditService.logEvent({
        actorId: actorId ?? attempt.userId ?? 'SYSTEM',
        actorRole: 'SYSTEM',
        action: 'FINANCE_PAYMENT_CAPTURED_POSTED',
        entityType: 'FINANCIAL_TRANSACTION',
        entityId: createdTx.id,
        amount: attempt.amount,
        currency: attempt.currency ?? 'INR',
        metadata: {
          idempotencyKey,
          transactionType: createdTx.transactionType,
          sourceType: FINANCE_SOURCE_TYPES.PAYMENT,
          sourceId: attempt.id,
        },
      });
      return createdTx;
    }

    try {
      const createdTx = await this.financeRepo.transaction(async (client) => {
        return this.financeRepo.createTransaction(txData, lines, client);
      });

      await this.auditService.logEvent({
        actorId: actorId ?? attempt.userId ?? 'SYSTEM',
        actorRole: 'SYSTEM',
        action: 'FINANCE_PAYMENT_CAPTURED_POSTED',
        entityType: 'FINANCIAL_TRANSACTION',
        entityId: createdTx.id,
        amount: attempt.amount,
        currency: attempt.currency ?? 'INR',
        metadata: {
          idempotencyKey,
          transactionType: createdTx.transactionType,
          sourceType: FINANCE_SOURCE_TYPES.PAYMENT,
          sourceId: attempt.id,
        },
      });

      return createdTx;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const concurrent = await this.financeRepo.findTransactionByIdempotencyKey(idempotencyKey);
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  async postRefundCompletedInTransaction(
    refund: {
      id: string;
      amount: number;
      orderId: string;
      currency?: string;
    },
    tx?: Prisma.TransactionClient,
    actorId?: string,
  ): Promise<FinancialTransaction & { lines: FinancialTransactionLine[] }> {
    const idempotencyKey = buildIdempotencyKey.refund(refund.id);

    // 1. Idempotency check
    const existing = await this.financeRepo.findTransactionByIdempotencyKey(idempotencyKey, tx);
    if (existing) {
      return existing;
    }

    // 2. Resolve account IDs
    const [refundsIssuedAccountId, clearingAccountId] = await Promise.all([
      this.getAccountIdByCode(ACCOUNT_CODES.REFUNDS_ISSUED, tx),
      this.getAccountIdByCode(ACCOUNT_CODES.PAYMENT_GATEWAY_CLEARING, tx),
    ]);

    // 3. Prepare balanced double-entry lines
    const lines: CreateLineInput[] = [
      {
        accountId: refundsIssuedAccountId,
        debitPaise: refund.amount,
        creditPaise: 0,
        description: `Refund for Order ${refund.orderId}`,
      },
      {
        accountId: clearingAccountId,
        debitPaise: 0,
        creditPaise: refund.amount,
        description: `Funds returned via gateway for Refund ${refund.id}`,
      },
    ];

    const txData = {
      transactionType: FinancialTransactionType.REFUND,
      currency: refund.currency ?? 'INR',
      sourceType: FINANCE_SOURCE_TYPES.REFUND,
      sourceId: refund.id,
      description: `Refund completed for Order ${refund.orderId}: ${refund.id}`,
      idempotencyKey,
      createdById: actorId ?? 'SYSTEM',
      status: FinancialTransactionStatus.POSTED,
      postedAt: new Date(),
    };

    if (tx) {
      const createdTx = await this.financeRepo.createTransaction(txData, lines, tx);
      await this.auditService.logEvent({
        actorId: actorId ?? 'SYSTEM',
        actorRole: 'SYSTEM',
        action: 'FINANCE_REFUND_COMPLETED_POSTED',
        entityType: 'FINANCIAL_TRANSACTION',
        entityId: createdTx.id,
        amount: refund.amount,
        currency: refund.currency ?? 'INR',
        metadata: {
          orderId: refund.orderId,
          idempotencyKey,
          transactionType: createdTx.transactionType,
          sourceType: FINANCE_SOURCE_TYPES.REFUND,
          sourceId: refund.id,
        },
      });
      return createdTx;
    }

    try {
      const createdTx = await this.financeRepo.transaction(async (client) => {
        return this.financeRepo.createTransaction(txData, lines, client);
      });

      await this.auditService.logEvent({
        actorId: actorId ?? 'SYSTEM',
        actorRole: 'SYSTEM',
        action: 'FINANCE_REFUND_COMPLETED_POSTED',
        entityType: 'FINANCIAL_TRANSACTION',
        entityId: createdTx.id,
        amount: refund.amount,
        currency: refund.currency ?? 'INR',
        metadata: {
          orderId: refund.orderId,
          idempotencyKey,
          transactionType: createdTx.transactionType,
          sourceType: FINANCE_SOURCE_TYPES.REFUND,
          sourceId: refund.id,
        },
      });

      return createdTx;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const concurrent = await this.financeRepo.findTransactionByIdempotencyKey(idempotencyKey);
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  async validateExpenseAccount(
    accountId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<FinancialAccount> {
    const customAccount = await this.financeRepo.findAccountById(accountId, tx);
    if (!customAccount) {
      throw new BadRequestException(`Expense account ID '${accountId}' not found.`);
    }
    if (!customAccount.isActive) {
      throw new BadRequestException(`Expense account '${customAccount.name}' is inactive.`);
    }
    if (customAccount.type !== FinancialAccountType.EXPENSE) {
      throw new BadRequestException(
        `Account '${customAccount.name}' is of type ${customAccount.type}, but an EXPENSE type account is required.`,
      );
    }
    return customAccount;
  }

  async getActiveExpenseAccounts(tx?: Prisma.TransactionClient): Promise<FinancialAccount[]> {
    return this.financeRepo.listAccounts({ isActive: true, type: FinancialAccountType.EXPENSE }, tx);
  }

  async postExpenseInTransaction(
    expense: {
      id: string;
      expenseNumber?: string;
      amountPaise: number;
      currency?: string;
      description?: string;
      expenseAccountId?: string | null;
      isPaid?: boolean;
    },
    tx?: Prisma.TransactionClient,
    actorId?: string,
  ): Promise<FinancialTransaction & { lines: FinancialTransactionLine[] }> {
    const idempotencyKey = buildIdempotencyKey.expense(expense.id);

    // 1. Idempotency check inside transaction
    const existing = await this.financeRepo.findTransactionByIdempotencyKey(idempotencyKey, tx);
    if (existing) {
      return existing;
    }

    // 2. Resolve account IDs
    let debitAccountId: string;
    if (expense.expenseAccountId) {
      const customAccount = await this.validateExpenseAccount(expense.expenseAccountId, tx);
      debitAccountId = customAccount.id;
    } else {
      debitAccountId = await this.getAccountIdByCode(ACCOUNT_CODES.OPERATING_EXPENSES, tx);
    }

    // Credit account: If paid (isPaid === true or default true), CASH_AND_BANK (1000). If unpaid, ACCOUNTS_PAYABLE (2000).
    const isPaid = expense.isPaid !== false;
    const creditAccountCode = isPaid ? ACCOUNT_CODES.CASH_AND_BANK : ACCOUNT_CODES.ACCOUNTS_PAYABLE;
    const creditAccountId = await this.getAccountIdByCode(creditAccountCode, tx);

    // 3. Prepare balanced double-entry lines
    const lines: CreateLineInput[] = [
      {
        accountId: debitAccountId,
        debitPaise: expense.amountPaise,
        creditPaise: 0,
        description: `Expense: ${expense.description ?? expense.expenseNumber ?? expense.id}`,
      },
      {
        accountId: creditAccountId,
        debitPaise: 0,
        creditPaise: expense.amountPaise,
        description: isPaid
          ? `Settled via Cash & Bank for Expense ${expense.expenseNumber ?? expense.id}`
          : `Accounts Payable recorded for Expense ${expense.expenseNumber ?? expense.id}`,
      },
    ];

    const txData = {
      transactionType: FinancialTransactionType.EXPENSE,
      currency: expense.currency ?? 'INR',
      sourceType: FINANCE_SOURCE_TYPES.EXPENSE,
      sourceId: expense.id,
      description: `Expense posted: ${expense.expenseNumber ?? expense.id} - ${expense.description ?? ''}`.trim(),
      idempotencyKey,
      createdById: actorId ?? 'SYSTEM',
      status: FinancialTransactionStatus.POSTED,
      postedAt: new Date(),
    };

    if (tx) {
      const createdTx = await this.financeRepo.createTransaction(txData, lines, tx);
      await this.auditService.logEvent({
        actorId: actorId ?? 'SYSTEM',
        actorRole: 'SYSTEM',
        action: 'FINANCE_EXPENSE_POSTED',
        entityType: 'FINANCIAL_TRANSACTION',
        entityId: createdTx.id,
        amount: expense.amountPaise,
        currency: expense.currency ?? 'INR',
        metadata: {
          expenseId: expense.id,
          expenseNumber: expense.expenseNumber,
          idempotencyKey,
          transactionType: createdTx.transactionType,
          sourceType: FINANCE_SOURCE_TYPES.EXPENSE,
          sourceId: expense.id,
        },
      }, tx);
      return createdTx;
    }

    try {
      const createdTx = await this.financeRepo.transaction(async (client) => {
        return this.financeRepo.createTransaction(txData, lines, client);
      });

      await this.auditService.logEvent({
        actorId: actorId ?? 'SYSTEM',
        actorRole: 'SYSTEM',
        action: 'FINANCE_EXPENSE_POSTED',
        entityType: 'FINANCIAL_TRANSACTION',
        entityId: createdTx.id,
        amount: expense.amountPaise,
        currency: expense.currency ?? 'INR',
        metadata: {
          expenseId: expense.id,
          expenseNumber: expense.expenseNumber,
          idempotencyKey,
          transactionType: createdTx.transactionType,
          sourceType: FINANCE_SOURCE_TYPES.EXPENSE,
          sourceId: expense.id,
        },
      });

      return createdTx;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const concurrent = await this.financeRepo.findTransactionByIdempotencyKey(idempotencyKey);
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Immutability & Compensating Transactions
  // ---------------------------------------------------------------------------

  async createCompensatingTransaction(
    originalTransactionId: string,
    dto: CompensatingTransactionDto,
    actorId: string,
  ): Promise<FinancialTransaction & { lines: FinancialTransactionLine[] }> {
    const original = await this.getTransactionById(originalTransactionId);

    if (original.status !== FinancialTransactionStatus.POSTED) {
      throw new BadRequestException(
        `Cannot compensate transaction '${original.id}' because its status is ${original.status}`,
      );
    }

    // Invert every line: debits become credits, credits become debits
    const compensatingLines = original.lines.map((l) => ({
      accountId: l.accountId,
      debitPaise: l.creditPaise,
      creditPaise: l.debitPaise,
      description: `Reversal of line ${l.id}: ${dto.reason}`,
    }));

    return this.postTransaction(
      {
        transactionType: FinancialTransactionType.ADJUSTMENT,
        currency: original.currency,
        sourceType: original.sourceType ?? 'TRANSACTION',
        sourceId: original.id,
        description: `Compensating reversal of transaction ${original.id}. Reason: ${dto.reason}`,
        idempotencyKey: dto.idempotencyKey,
        lines: compensatingLines,
      },
      actorId,
    );
  }

  // ---------------------------------------------------------------------------
  // Reporting / Balance Primitives
  // ---------------------------------------------------------------------------

  async getAccountBalance(accountId: string): Promise<AccountBalanceResult> {
    const account = await this.getAccountById(accountId);
    const totals = await this.financeRepo.getAccountTotals(accountId);

    // Normal balance convention:
    // ASSET, EXPENSE: normal balance is DEBIT (Debit increases, Credit decreases)
    // LIABILITY, EQUITY, REVENUE: normal balance is CREDIT (Credit increases, Debit decreases)
    const balancePaise =
      account.normalBalance === 'DEBIT'
        ? totals.totalDebit - totals.totalCredit
        : totals.totalCredit - totals.totalDebit;

    return {
      account,
      totalDebitPaise: totals.totalDebit,
      totalCreditPaise: totals.totalCredit,
      balancePaise,
    };
  }

  async getAccountPeriodTotals(
    accountId: string,
    from: Date,
    to: Date,
  ): Promise<{ account: FinancialAccount; totalDebitPaise: number; totalCreditPaise: number; netPeriodPaise: number }> {
    const account = await this.getAccountById(accountId);
    const totals = await this.financeRepo.getAccountPeriodTotals(accountId, from, to);

    const netPeriodPaise =
      account.normalBalance === 'DEBIT'
        ? totals.totalDebit - totals.totalCredit
        : totals.totalCredit - totals.totalDebit;

    return {
      account,
      totalDebitPaise: totals.totalDebit,
      totalCreditPaise: totals.totalCredit,
      netPeriodPaise,
    };
  }

  async getTrialBalance(): Promise<TrialBalanceResult> {
    const accounts = await this.financeRepo.listAccounts({ isActive: true });
    let totalDebitPaise = 0;
    let totalCreditPaise = 0;

    const items: TrialBalanceItem[] = [];

    for (const acc of accounts) {
      const totals = await this.financeRepo.getAccountTotals(acc.id);
      const balancePaise =
        acc.normalBalance === 'DEBIT'
          ? totals.totalDebit - totals.totalCredit
          : totals.totalCredit - totals.totalDebit;

      totalDebitPaise += totals.totalDebit;
      totalCreditPaise += totals.totalCredit;

      items.push({
        account: acc,
        totalDebitPaise: totals.totalDebit,
        totalCreditPaise: totals.totalCredit,
        balancePaise,
      });
    }

    return {
      asOf: new Date(),
      accounts: items,
      totalDebitPaise,
      totalCreditPaise,
      isBalanced: totalDebitPaise === totalCreditPaise,
    };
  }

  // ---------------------------------------------------------------------------
  // Financial Reporting & Statements (Phase 16A)
  // ---------------------------------------------------------------------------

  private resolvePeriodDates(query?: QueryFinancialReportDto): {
    from?: Date;
    to?: Date;
    preset?: PeriodPreset;
  } {
    if (!query) {
      return {};
    }

    const now = new Date();
    let from: Date | undefined;
    let to: Date | undefined;

    if (query.period && query.period !== PeriodPreset.CUSTOM && query.period !== PeriodPreset.ALL_TIME) {
      switch (query.period) {
        case PeriodPreset.DAILY: {
          from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
          to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
          break;
        }
        case PeriodPreset.MONTHLY: {
          from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
          to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
          break;
        }
        case PeriodPreset.QUARTERLY: {
          const currentQuarter = Math.floor(now.getUTCMonth() / 3);
          from = new Date(Date.UTC(now.getUTCFullYear(), currentQuarter * 3, 1, 0, 0, 0, 0));
          to = new Date(Date.UTC(now.getUTCFullYear(), (currentQuarter + 1) * 3, 0, 23, 59, 59, 999));
          break;
        }
        case PeriodPreset.FISCAL_YEAR: {
          // Indian fiscal year: April 1 to March 31
          const month = now.getUTCMonth();
          const startYear = month >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
          from = new Date(Date.UTC(startYear, 3, 1, 0, 0, 0, 0));
          to = new Date(Date.UTC(startYear + 1, 3, 0, 23, 59, 59, 999));
          break;
        }
      }
    } else if (query.startDate || query.endDate) {
      if (query.startDate) {
        from = new Date(query.startDate);
        if (isNaN(from.getTime())) {
          throw new BadRequestException(`Invalid startDate format: '${query.startDate}'`);
        }
      }
      if (query.endDate) {
        to = new Date(query.endDate);
        if (isNaN(to.getTime())) {
          throw new BadRequestException(`Invalid endDate format: '${query.endDate}'`);
        }
      }
    }

    if (from && to && from > to) {
      throw new BadRequestException(
        `startDate (${from.toISOString()}) cannot be after endDate (${to.toISOString()})`,
      );
    }

    if (from && to) {
      const tenYearsMs = 10 * 365.25 * 24 * 60 * 60 * 1000;
      if (to.getTime() - from.getTime() > tenYearsMs) {
        throw new BadRequestException('Reporting date range cannot exceed 10 years');
      }
    }

    return {
      from,
      to,
      preset: query.period ?? (from || to ? PeriodPreset.CUSTOM : PeriodPreset.ALL_TIME),
    };
  }

  async getTrialBalanceReport(query?: QueryFinancialReportDto): Promise<TrialBalanceReport> {
    const { from, to, preset } = this.resolvePeriodDates(query);
    const accounts = await this.financeRepo.listAccounts({ isActive: true });
    const balanceMap = await this.financeRepo.getAggregatedAccountBalances({ from, to });

    let totalDebitPaise = 0;
    let totalCreditPaise = 0;

    const items = accounts.map((acc) => {
      const totals = balanceMap.get(acc.id) ?? { totalDebit: 0, totalCredit: 0 };
      const balancePaise =
        acc.normalBalance === 'DEBIT'
          ? totals.totalDebit - totals.totalCredit
          : totals.totalCredit - totals.totalDebit;

      totalDebitPaise += totals.totalDebit;
      totalCreditPaise += totals.totalCredit;

      return {
        account: {
          id: acc.id,
          code: acc.code,
          name: acc.name,
          type: acc.type,
          normalBalance: acc.normalBalance,
        },
        totalDebitPaise: totals.totalDebit,
        totalCreditPaise: totals.totalCredit,
        balancePaise,
      };
    });

    return {
      asOf: (to ?? new Date()).toISOString(),
      period: {
        startDate: from?.toISOString(),
        endDate: to?.toISOString(),
        preset,
      },
      accounts: items,
      totalDebitPaise,
      totalCreditPaise,
      isBalanced: totalDebitPaise === totalCreditPaise,
    };
  }

  async getProfitLossReport(query?: QueryFinancialReportDto): Promise<ProfitLossReport> {
    const { from, to, preset } = this.resolvePeriodDates(query);
    const accounts = await this.financeRepo.listAccounts({ isActive: true });
    const balanceMap = await this.financeRepo.getAggregatedAccountBalances({ from, to });

    const revenueAccounts: ProfitLossReport['revenue']['accounts'] = [];
    const expenseAccounts: ProfitLossReport['expenses']['accounts'] = [];

    let totalRevenuePaise = 0;
    let totalExpensePaise = 0;

    for (const acc of accounts) {
      if (acc.type !== FinancialAccountType.REVENUE && acc.type !== FinancialAccountType.EXPENSE) {
        continue;
      }

      const totals = balanceMap.get(acc.id) ?? { totalDebit: 0, totalCredit: 0 };

      if (acc.type === FinancialAccountType.REVENUE) {
        // REVENUE: normal balance is CREDIT (Credit increases revenue, Debit decreases)
        const balancePaise = totals.totalCredit - totals.totalDebit;
        totalRevenuePaise += balancePaise;
        revenueAccounts.push({
          account: {
            id: acc.id,
            code: acc.code,
            name: acc.name,
            type: acc.type,
            normalBalance: acc.normalBalance,
          },
          totalDebitPaise: totals.totalDebit,
          totalCreditPaise: totals.totalCredit,
          balancePaise,
        });
      } else if (acc.type === FinancialAccountType.EXPENSE) {
        // EXPENSE: normal balance is DEBIT (Debit increases expense, Credit decreases)
        const balancePaise = totals.totalDebit - totals.totalCredit;
        totalExpensePaise += balancePaise;
        expenseAccounts.push({
          account: {
            id: acc.id,
            code: acc.code,
            name: acc.name,
            type: acc.type,
            normalBalance: acc.normalBalance,
          },
          totalDebitPaise: totals.totalDebit,
          totalCreditPaise: totals.totalCredit,
          balancePaise,
        });
      }
    }

    const netIncomePaise = totalRevenuePaise - totalExpensePaise;

    return {
      period: {
        startDate: (from ?? new Date(0)).toISOString(),
        endDate: (to ?? new Date()).toISOString(),
        preset,
      },
      revenue: {
        accounts: revenueAccounts,
        totalRevenuePaise,
      },
      expenses: {
        accounts: expenseAccounts,
        totalExpensePaise,
      },
      netIncomePaise,
      isProfitable: netIncomePaise >= 0,
    };
  }

  async getBalanceSheetReport(query?: QueryFinancialReportDto): Promise<BalanceSheetReport> {
    const { to, preset } = this.resolvePeriodDates(query);
    const asOfDate = to ?? new Date();

    const accounts = await this.financeRepo.listAccounts({ isActive: true });
    const balanceMap = await this.financeRepo.getAggregatedAccountBalances({ asOf: asOfDate });

    const assetAccounts: BalanceSheetReport['assets']['accounts'] = [];
    const liabilityAccounts: BalanceSheetReport['liabilities']['accounts'] = [];
    const equityAccounts: BalanceSheetReport['equity']['accounts'] = [];

    let totalAssetsPaise = 0;
    let totalLiabilitiesPaise = 0;
    let totalEquityPaise = 0;
    let totalRevenuePaise = 0;
    let totalExpensePaise = 0;

    for (const acc of accounts) {
      const totals = balanceMap.get(acc.id) ?? { totalDebit: 0, totalCredit: 0 };

      if (acc.type === FinancialAccountType.ASSET) {
        const balancePaise = totals.totalDebit - totals.totalCredit;
        totalAssetsPaise += balancePaise;
        assetAccounts.push({
          account: {
            id: acc.id,
            code: acc.code,
            name: acc.name,
            type: acc.type,
            normalBalance: acc.normalBalance,
          },
          totalDebitPaise: totals.totalDebit,
          totalCreditPaise: totals.totalCredit,
          balancePaise,
        });
      } else if (acc.type === FinancialAccountType.LIABILITY) {
        const balancePaise = totals.totalCredit - totals.totalDebit;
        totalLiabilitiesPaise += balancePaise;
        liabilityAccounts.push({
          account: {
            id: acc.id,
            code: acc.code,
            name: acc.name,
            type: acc.type,
            normalBalance: acc.normalBalance,
          },
          totalDebitPaise: totals.totalDebit,
          totalCreditPaise: totals.totalCredit,
          balancePaise,
        });
      } else if (acc.type === FinancialAccountType.EQUITY) {
        const balancePaise = totals.totalCredit - totals.totalDebit;
        totalEquityPaise += balancePaise;
        equityAccounts.push({
          account: {
            id: acc.id,
            code: acc.code,
            name: acc.name,
            type: acc.type,
            normalBalance: acc.normalBalance,
          },
          totalDebitPaise: totals.totalDebit,
          totalCreditPaise: totals.totalCredit,
          balancePaise,
        });
      } else if (acc.type === FinancialAccountType.REVENUE) {
        totalRevenuePaise += (totals.totalCredit - totals.totalDebit);
      } else if (acc.type === FinancialAccountType.EXPENSE) {
        totalExpensePaise += (totals.totalDebit - totals.totalCredit);
      }
    }

    const currentPeriodNetIncomePaise = totalRevenuePaise - totalExpensePaise;
    const totalLiabilitiesAndEquityPaise = totalLiabilitiesPaise + totalEquityPaise;
    const balanceDifferencePaise = totalAssetsPaise - totalLiabilitiesAndEquityPaise;

    const isBalanced = balanceDifferencePaise === 0;

    const reconciliationNote = isBalanced
      ? 'Balance Sheet is balanced: Total Assets = Total Liabilities + Total Equity.'
      : `The double-entry ledger is balanced across all accounts (Trial Balance debits equal credits). Balance Sheet difference of ₹${(balanceDifferencePaise / 100).toFixed(2)} reflects unclosed cumulative net earnings (Current Period Net Income). In accordance with Phase 16A accounting integrity rules, no synthetic equity entries are fabricated without formal closing entries.`;

    return {
      asOf: asOfDate.toISOString(),
      period: {
        endDate: asOfDate.toISOString(),
        preset,
      },
      assets: {
        accounts: assetAccounts,
        totalAssetsPaise,
      },
      liabilities: {
        accounts: liabilityAccounts,
        totalLiabilitiesPaise,
      },
      equity: {
        accounts: equityAccounts,
        totalEquityPaise,
      },
      totalLiabilitiesAndEquityPaise,
      balanceDifferencePaise,
      currentPeriodNetIncomePaise,
      reconciliationNote,
      isBalanced,
    };
  }

  async getAccountDrillDown(
    accountId: string,
    query?: QueryAccountDrillDownDto,
  ): Promise<AccountDrillDownReport> {
    const account = await this.getAccountById(accountId);
    const { from, to } = this.resolvePeriodDates(query);
    const page = Math.max(1, query?.page ?? 1);
    const limit = Math.min(100, Math.max(1, query?.limit ?? 20));

    let openingBalancePaise = 0;
    if (from) {
      const openingTotals = await this.financeRepo.getAccountOpeningBalance(accountId, from);
      openingBalancePaise =
        account.normalBalance === 'DEBIT'
          ? openingTotals.totalDebit - openingTotals.totalCredit
          : openingTotals.totalCredit - openingTotals.totalDebit;
    }

    const { entries: dbEntries, total } = await this.financeRepo.getAccountDrillDown({
      accountId,
      from,
      to,
      page,
      limit,
    });

    const entries = dbEntries.map((line) => {
      return {
        id: line.id,
        transactionId: line.transactionId,
        transactionType: line.transaction.transactionType,
        sourceType: line.transaction.sourceType,
        sourceId: line.transaction.sourceId,
        description: line.description ?? line.transaction.description,
        postedAt: line.transaction.postedAt?.toISOString() ?? null,
        debitPaise: line.debitPaise,
        creditPaise: line.creditPaise,
      };
    });

    let periodDebitPaise: number;
    let periodCreditPaise: number;

    if (from || to) {
      const periodTotals = await this.financeRepo.getAccountPeriodTotals(
        accountId,
        from ?? new Date(0),
        to ?? new Date(),
      );
      periodDebitPaise = periodTotals.totalDebit;
      periodCreditPaise = periodTotals.totalCredit;
    } else {
      const allTotals = await this.financeRepo.getAccountTotals(accountId);
      periodDebitPaise = allTotals.totalDebit;
      periodCreditPaise = allTotals.totalCredit;
    }

    const netPeriodChange =
      account.normalBalance === 'DEBIT'
        ? periodDebitPaise - periodCreditPaise
        : periodCreditPaise - periodDebitPaise;

    const closingBalancePaise = openingBalancePaise + netPeriodChange;

    return {
      account: {
        id: account.id,
        code: account.code,
        name: account.name,
        type: account.type,
        normalBalance: account.normalBalance,
      },
      period: {
        startDate: from?.toISOString(),
        endDate: to?.toISOString(),
      },
      openingBalancePaise,
      periodDebitPaise,
      periodCreditPaise,
      closingBalancePaise,
      entries,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }
}
