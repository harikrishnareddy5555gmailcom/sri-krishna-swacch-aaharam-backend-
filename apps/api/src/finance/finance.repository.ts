/**
 * Finance Repository — Phase 15A
 *
 * Low-level database operations for FinancialAccount, FinancialTransaction,
 * and FinancialTransactionLine. Supports Prisma transaction delegation (tx).
 *
 * No business logic here — only persistence operations.
 */

import { Injectable } from '@nestjs/common';
import {
  type FinancialAccount,
  type FinancialTransaction,
  type FinancialTransactionLine,
  type Prisma,
  FinancialTransactionStatus,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';

export interface CreateLineInput {
  accountId: string;
  debitPaise: number;
  creditPaise: number;
  description?: string | null;
}

@Injectable()
export class FinanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient): Prisma.TransactionClient | PrismaService {
    return tx ?? this.prisma;
  }

  async transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }

  // Account Operations

  async createAccount(
    data: Prisma.FinancialAccountCreateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<FinancialAccount> {
    return this.getClient(tx).financialAccount.create({ data });
  }

  async findAccountById(id: string, tx?: Prisma.TransactionClient): Promise<FinancialAccount | null> {
    return this.getClient(tx).financialAccount.findUnique({ where: { id } });
  }

  async findAccountByCode(code: string, tx?: Prisma.TransactionClient): Promise<FinancialAccount | null> {
    return this.getClient(tx).financialAccount.findUnique({ where: { code } });
  }

  async findAccountsByIds(ids: string[], tx?: Prisma.TransactionClient): Promise<FinancialAccount[]> {
    return this.getClient(tx).financialAccount.findMany({ where: { id: { in: ids } } });
  }

  async listAccounts(
    filters: { isActive?: boolean; type?: string },
    tx?: Prisma.TransactionClient,
  ): Promise<FinancialAccount[]> {
    const where: Prisma.FinancialAccountWhereInput = {};
    if (filters.isActive !== undefined) where.isActive = filters.isActive;
    if (filters.type) where.type = filters.type as Prisma.FinancialAccountWhereInput['type'];
    return this.getClient(tx).financialAccount.findMany({ where, orderBy: { code: 'asc' } });
  }

  async deactivateAccount(id: string, tx?: Prisma.TransactionClient): Promise<FinancialAccount> {
    return this.getClient(tx).financialAccount.update({ where: { id }, data: { isActive: false } });
  }

  async reactivateAccount(id: string, tx?: Prisma.TransactionClient): Promise<FinancialAccount> {
    return this.getClient(tx).financialAccount.update({ where: { id }, data: { isActive: true } });
  }

  async hasReferencedLines(accountId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
    const count = await this.getClient(tx).financialTransactionLine.count({ where: { accountId } });
    return count > 0;
  }

  // Transaction Operations

  async findTransactionById(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<(FinancialTransaction & { lines: FinancialTransactionLine[] }) | null> {
    return this.getClient(tx).financialTransaction.findUnique({ where: { id }, include: { lines: true } });
  }

  async findTransactionByIdempotencyKey(
    idempotencyKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<(FinancialTransaction & { lines: FinancialTransactionLine[] }) | null> {
    return this.getClient(tx).financialTransaction.findUnique({ where: { idempotencyKey }, include: { lines: true } });
  }

  async listTransactions(filters: {
    status?: FinancialTransactionStatus;
    sourceType?: string;
    sourceId?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: FinancialTransaction[]; total: number }> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20));
    const skip = (page - 1) * limit;
    const where: Prisma.FinancialTransactionWhereInput = {};
    if (filters.status) where.status = filters.status;
    if (filters.sourceType) where.sourceType = filters.sourceType;
    if (filters.sourceId) where.sourceId = filters.sourceId;
    const [data, total] = await Promise.all([
      this.prisma.financialTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.financialTransaction.count({ where }),
    ]);
    return { data, total };
  }

  async createTransaction(
    data: {
      transactionType: Prisma.FinancialTransactionCreateInput['transactionType'];
      currency?: string;
      sourceType?: string | null;
      sourceId?: string | null;
      description: string;
      idempotencyKey: string;
      createdById: string;
      status?: FinancialTransactionStatus;
      postedAt?: Date | null;
    },
    lines: CreateLineInput[],
    tx?: Prisma.TransactionClient,
  ): Promise<FinancialTransaction & { lines: FinancialTransactionLine[] }> {
    const client = this.getClient(tx);
    const status = data.status ?? FinancialTransactionStatus.POSTED;
    const postedAt = data.postedAt !== undefined ? data.postedAt : (status === FinancialTransactionStatus.POSTED ? new Date() : null);

    return client.financialTransaction.create({
      data: {
        transactionType: data.transactionType,
        currency: data.currency ?? 'INR',
        sourceType: data.sourceType ?? null,
        sourceId: data.sourceId ?? null,
        description: data.description,
        idempotencyKey: data.idempotencyKey,
        createdById: data.createdById,
        status,
        postedAt,
        lines: {
          create: lines.map((l) => ({
            accountId: l.accountId,
            debitPaise: l.debitPaise,
            creditPaise: l.creditPaise,
            description: l.description ?? null,
          })),
        },
      },
      include: { lines: true },
    });
  }

  async markPosted(id: string, tx?: Prisma.TransactionClient): Promise<FinancialTransaction> {
    return this.getClient(tx).financialTransaction.update({
      where: { id },
      data: { status: FinancialTransactionStatus.POSTED, postedAt: new Date() },
    });
  }

  // Reporting Primitives

  async getAccountTotals(accountId: string): Promise<{ totalDebit: number; totalCredit: number }> {
    const result = await this.prisma.financialTransactionLine.aggregate({
      where: { accountId, transaction: { status: FinancialTransactionStatus.POSTED } },
      _sum: { debitPaise: true, creditPaise: true },
    });
    return { totalDebit: result._sum.debitPaise ?? 0, totalCredit: result._sum.creditPaise ?? 0 };
  }

  async getAccountPeriodTotals(
    accountId: string,
    from: Date,
    to: Date,
  ): Promise<{ totalDebit: number; totalCredit: number }> {
    const result = await this.prisma.financialTransactionLine.aggregate({
      where: {
        accountId,
        transaction: { status: FinancialTransactionStatus.POSTED, postedAt: { gte: from, lte: to } },
      },
      _sum: { debitPaise: true, creditPaise: true },
    });
    return { totalDebit: result._sum.debitPaise ?? 0, totalCredit: result._sum.creditPaise ?? 0 };
  }

  /**
   * High-performance single database aggregation for trial balance, P&L, and balance sheet.
   * Groups all posted ledger lines by accountId in PostgreSQL.
   */
  async getAggregatedAccountBalances(options?: {
    from?: Date;
    to?: Date;
    asOf?: Date;
  }): Promise<Map<string, { totalDebit: number; totalCredit: number }>> {
    const where: Prisma.FinancialTransactionLineWhereInput = {
      transaction: {
        status: FinancialTransactionStatus.POSTED,
      },
    };

    if (options?.from || options?.to) {
      const postedAt: Prisma.DateTimeFilter = {};
      if (options.from) postedAt.gte = options.from;
      if (options.to) postedAt.lte = options.to;
      where.transaction = {
        status: FinancialTransactionStatus.POSTED,
        postedAt,
      };
    } else if (options?.asOf) {
      where.transaction = {
        status: FinancialTransactionStatus.POSTED,
        postedAt: { lte: options.asOf },
      };
    }

    const grouped = await this.prisma.financialTransactionLine.groupBy({
      by: ['accountId'],
      where,
      _sum: {
        debitPaise: true,
        creditPaise: true,
      },
    });

    const balanceMap = new Map<string, { totalDebit: number; totalCredit: number }>();
    for (const item of grouped) {
      balanceMap.set(item.accountId, {
        totalDebit: item._sum.debitPaise ?? 0,
        totalCredit: item._sum.creditPaise ?? 0,
      });
    }

    return balanceMap;
  }

  /**
   * Retrieves opening balance for an account prior to a given date.
   */
  async getAccountOpeningBalance(
    accountId: string,
    beforeDate: Date,
  ): Promise<{ totalDebit: number; totalCredit: number }> {
    const result = await this.prisma.financialTransactionLine.aggregate({
      where: {
        accountId,
        transaction: {
          status: FinancialTransactionStatus.POSTED,
          postedAt: { lt: beforeDate },
        },
      },
      _sum: { debitPaise: true, creditPaise: true },
    });
    return {
      totalDebit: result._sum.debitPaise ?? 0,
      totalCredit: result._sum.creditPaise ?? 0,
    };
  }

  /**
   * Paginated drill-down for underlying posted ledger entries.
   */
  async getAccountDrillDown(options: {
    accountId: string;
    from?: Date;
    to?: Date;
    page: number;
    limit: number;
  }): Promise<{
    entries: Array<FinancialTransactionLine & { transaction: FinancialTransaction }>;
    total: number;
  }> {
    const where: Prisma.FinancialTransactionLineWhereInput = {
      accountId: options.accountId,
      transaction: {
        status: FinancialTransactionStatus.POSTED,
      },
    };

    if (options.from || options.to) {
      const postedAt: Prisma.DateTimeFilter = {};
      if (options.from) postedAt.gte = options.from;
      if (options.to) postedAt.lte = options.to;
      where.transaction = {
        status: FinancialTransactionStatus.POSTED,
        postedAt,
      };
    }

    const skip = (options.page - 1) * options.limit;

    const [entries, total] = await Promise.all([
      this.prisma.financialTransactionLine.findMany({
        where,
        include: { transaction: true },
        orderBy: [
          { transaction: { postedAt: 'desc' } },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
        skip,
        take: options.limit,
      }),
      this.prisma.financialTransactionLine.count({ where }),
    ]);

    return { entries, total };
  }

  /**
   * Aggregates authoritative domain totals (orders, refunds, expenses) for executive financial summary.
   */
  async getExecutiveDomainAggregates(options?: { from?: Date; to?: Date }) {
    const orderDateFilter: Prisma.DateTimeFilter = {};
    const expenseDateFilter: Prisma.DateTimeFilter = {};
    const refundDateFilter: Prisma.DateTimeFilter = {};

    if (options?.from) {
      orderDateFilter.gte = options.from;
      expenseDateFilter.gte = options.from;
      refundDateFilter.gte = options.from;
    }
    if (options?.to) {
      orderDateFilter.lte = options.to;
      expenseDateFilter.lte = options.to;
      refundDateFilter.lte = options.to;
    }

    const hasDate = Boolean(options?.from || options?.to);

    const [
      ordersGrouped,
      ordersTotal,
      refundsCompleted,
      expensesGrouped,
      expensesByCategory,
      recentOrders,
    ] = await Promise.all([
      // Orders grouped by status
      this.prisma.order.groupBy({
        by: ['status'],
        where: hasDate ? { createdAt: orderDateFilter } : {},
        _sum: { totalAmount: true },
        _count: { id: true },
      }),
      // Total orders
      this.prisma.order.aggregate({
        where: hasDate ? { createdAt: orderDateFilter } : {},
        _sum: { totalAmount: true },
        _count: { id: true },
      }),
      // Completed refunds
      this.prisma.refund.aggregate({
        where: {
          status: 'COMPLETED',
          ...(hasDate ? { createdAt: refundDateFilter } : {}),
        },
        _sum: { amount: true },
        _count: { id: true },
      }),
      // Expenses by status
      this.prisma.expense.groupBy({
        by: ['status'],
        where: hasDate ? { expenseDate: expenseDateFilter } : {},
        _sum: { amountPaise: true },
        _count: { id: true },
      }),
      // Expenses by category (only approved/posted or submitted)
      this.prisma.expense.groupBy({
        by: ['category'],
        where: {
          status: { notIn: ['REJECTED', 'CANCELLED'] },
          ...(hasDate ? { expenseDate: expenseDateFilter } : {}),
        },
        _sum: { amountPaise: true },
        _count: { id: true },
      }),
      // Recent orders with customer and refund status
      this.prisma.order.findMany({
        where: hasDate ? { createdAt: orderDateFilter } : {},
        take: 20,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
          paymentAttempt: { select: { status: true, amount: true } },
          refunds: { select: { status: true, amount: true } },
        },
      }),
    ]);

    return {
      ordersGrouped,
      ordersTotal,
      refundsCompleted,
      expensesGrouped,
      expensesByCategory,
      recentOrders,
    };
  }

  async findCancelledOrders() {
    return this.prisma.order.findMany({
      where: { status: 'CANCELLED' },
      select: { id: true, totalAmount: true, currency: true },
    });
  }

}
