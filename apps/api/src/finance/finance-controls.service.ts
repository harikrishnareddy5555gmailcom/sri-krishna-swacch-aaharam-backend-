import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import {
  FinancialTransactionStatus,
  PaymentStatus,
  RefundStatus,
  ExpenseStatus,
} from '@prisma/client';
import {
  ControlFinding,
  ControlSeverity,
  ControlType,
  ControlSummary,
  DomainReconciliationStats,
  FinanceControlsReportDto,
  QueryFinanceControlsDto,
} from './dto/finance-controls.dto.js';
import { PeriodPreset } from './dto/finance-reports.dto.js';
import { FINANCE_SOURCE_TYPES } from './finance.constants.js';

interface ResolvedControlPeriod {
  from?: Date;
  to?: Date;
  preset?: PeriodPreset;
}

@Injectable()
export class FinanceControlsService {
  private readonly logger = new Logger(FinanceControlsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves date bounds and validates query inputs.
   */
  resolveControlDates(query?: QueryFinanceControlsDto): ResolvedControlPeriod {
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
        throw new BadRequestException('Control check date range cannot exceed 10 years');
      }
    }

    return {
      from,
      to,
      preset: query.period ?? (from || to ? PeriodPreset.CUSTOM : PeriodPreset.ALL_TIME),
    };
  }

  /**
   * 1. LEDGER INTEGRITY CONTROL
   * Verifies double-entry and structural invariants on authoritative POSTED transactions:
   * - >= 2 lines per transaction
   * - balanced (sum debit == sum credit)
   * - each line has non-negative debit & credit
   * - each line has exactly one of debit/credit > 0
   * - referenced accounts exist and are active
   */
  async verifyLedgerIntegrity(
    query?: QueryFinanceControlsDto,
  ): Promise<{
    findings: ControlFinding[];
    stats: {
      transactionsChecked: number;
      violationsCount: number;
      status: 'PASSED' | 'FAILED';
    };
  }> {
    const { from, to } = this.resolveControlDates(query);
    const limit = Math.min(Math.max(query?.limit ?? 500, 1), 2000);

    const whereClause: {
      status: FinancialTransactionStatus;
      postedAt?: { gte?: Date; lte?: Date };
    } = {
      status: FinancialTransactionStatus.POSTED,
    };

    if (from || to) {
      whereClause.postedAt = {};
      if (from) whereClause.postedAt.gte = from;
      if (to) whereClause.postedAt.lte = to;
    }

    const transactions = await this.prisma.financialTransaction.findMany({
      where: whereClause,
      take: limit,
      orderBy: { postedAt: 'desc' },
      include: {
        lines: {
          include: {
            account: true,
          },
        },
      },
    });

    const findings: ControlFinding[] = [];
    const nowIso = new Date().toISOString();

    for (const tx of transactions) {
      let txHasViolation = false;

      // Invariant: At least 2 lines
      if (!tx.lines || tx.lines.length < 2) {
        findings.push({
          id: `li_lines_${tx.id}`,
          controlType: ControlType.LEDGER_INTEGRITY,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'LI_INSUFFICIENT_LINES',
          transactionId: tx.id,
          sourceType: tx.sourceType ?? undefined,
          sourceId: tx.sourceId ?? undefined,
          currency: tx.currency,
          description: `Transaction '${tx.id}' has ${tx.lines?.length ?? 0} lines, but requires at least 2 lines.`,
          detectedAt: nowIso,
        });
        txHasViolation = true;
      }

      let totalDebit = 0;
      let totalCredit = 0;

      for (let i = 0; i < tx.lines.length; i++) {
        const line = tx.lines[i];
        if (!line) continue;

        // Line non-negative amounts
        if (line.debitPaise < 0 || line.creditPaise < 0) {
          findings.push({
            id: `li_neg_${line.id}`,
            controlType: ControlType.LEDGER_INTEGRITY,
            severity: ControlSeverity.CRITICAL,
            ruleCode: 'LI_NEGATIVE_AMOUNT',
            transactionId: tx.id,
            sourceType: tx.sourceType ?? undefined,
            sourceId: tx.sourceId ?? undefined,
            expectedAmountPaise: 0,
            actualAmountPaise: Math.min(line.debitPaise, line.creditPaise),
            currency: tx.currency,
            description: `Transaction '${tx.id}' line ${i + 1} has negative amount (debit: ${line.debitPaise}, credit: ${line.creditPaise}).`,
            detectedAt: nowIso,
          });
          txHasViolation = true;
        }

        // Line cannot have both debit > 0 and credit > 0
        if (line.debitPaise > 0 && line.creditPaise > 0) {
          findings.push({
            id: `li_dual_${line.id}`,
            controlType: ControlType.LEDGER_INTEGRITY,
            severity: ControlSeverity.CRITICAL,
            ruleCode: 'LI_DUAL_DEBIT_CREDIT',
            transactionId: tx.id,
            sourceType: tx.sourceType ?? undefined,
            sourceId: tx.sourceId ?? undefined,
            currency: tx.currency,
            description: `Transaction '${tx.id}' line ${i + 1} has both debit (${line.debitPaise}) and credit (${line.creditPaise}).`,
            detectedAt: nowIso,
          });
          txHasViolation = true;
        }

        // Line cannot have both zero
        if (line.debitPaise === 0 && line.creditPaise === 0) {
          findings.push({
            id: `li_zero_${line.id}`,
            controlType: ControlType.LEDGER_INTEGRITY,
            severity: ControlSeverity.WARNING,
            ruleCode: 'LI_ZERO_LINE_AMOUNT',
            transactionId: tx.id,
            sourceType: tx.sourceType ?? undefined,
            sourceId: tx.sourceId ?? undefined,
            currency: tx.currency,
            description: `Transaction '${tx.id}' line ${i + 1} has both zero debit and zero credit.`,
            detectedAt: nowIso,
          });
          txHasViolation = true;
        }

        // Account existence
        if (!line.account) {
          findings.push({
            id: `li_no_acc_${line.id}`,
            controlType: ControlType.LEDGER_INTEGRITY,
            severity: ControlSeverity.CRITICAL,
            ruleCode: 'LI_ACCOUNT_NOT_FOUND',
            transactionId: tx.id,
            sourceType: tx.sourceType ?? undefined,
            sourceId: tx.sourceId ?? undefined,
            currency: tx.currency,
            description: `Transaction '${tx.id}' line ${i + 1} references non-existent account ID '${line.accountId}'.`,
            detectedAt: nowIso,
          });
          txHasViolation = true;
        } else if (!line.account.isActive) {
          // Account inactive
          findings.push({
            id: `li_inactive_acc_${line.id}`,
            controlType: ControlType.LEDGER_INTEGRITY,
            severity: ControlSeverity.WARNING,
            ruleCode: 'LI_INACTIVE_ACCOUNT_POSTING',
            transactionId: tx.id,
            sourceType: tx.sourceType ?? undefined,
            sourceId: tx.sourceId ?? undefined,
            currency: tx.currency,
            description: `Transaction '${tx.id}' line ${i + 1} references inactive account '${line.account.code}' (${line.account.name}).`,
            detectedAt: nowIso,
          });
        }

        totalDebit += line.debitPaise;
        totalCredit += line.creditPaise;
      }

      // Invariant: Balance (debit == credit)
      if (totalDebit !== totalCredit) {
        findings.push({
          id: `li_unbalanced_${tx.id}`,
          controlType: ControlType.LEDGER_INTEGRITY,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'LI_UNBALANCED_TRANSACTION',
          transactionId: tx.id,
          sourceType: tx.sourceType ?? undefined,
          sourceId: tx.sourceId ?? undefined,
          expectedAmountPaise: totalDebit,
          actualAmountPaise: totalCredit,
          currency: tx.currency,
          description: `Transaction '${tx.id}' is unbalanced: debit (${totalDebit}) != credit (${totalCredit}).`,
          detectedAt: nowIso,
        });
        txHasViolation = true;
      }

      // Invariant: Positive transaction total
      if (totalDebit <= 0 && !txHasViolation) {
        findings.push({
          id: `li_zero_total_${tx.id}`,
          controlType: ControlType.LEDGER_INTEGRITY,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'LI_ZERO_TOTAL_TRANSACTION',
          transactionId: tx.id,
          sourceType: tx.sourceType ?? undefined,
          sourceId: tx.sourceId ?? undefined,
          expectedAmountPaise: 1,
          actualAmountPaise: totalDebit,
          currency: tx.currency,
          description: `Transaction '${tx.id}' total amount is non-positive (${totalDebit} paise).`,
          detectedAt: nowIso,
        });
      }
    }

    return {
      findings,
      stats: {
        transactionsChecked: transactions.length,
        violationsCount: findings.length,
        status: findings.length === 0 ? 'PASSED' : 'FAILED',
      },
    };
  }

  /**
   * 2. FINANCIAL RECONCILIATION CONTROLS
   * Checks deterministic mappings between business domains and the ledger:
   * - Orders / SALE postings
   * - PaymentAttempt / PAYMENT postings
   * - Refund / REFUND postings
   * - Expense / EXPENSE postings
   */
  async runDomainReconciliations(
    query?: QueryFinanceControlsDto,
  ): Promise<{
    findings: ControlFinding[];
    domainStats: {
      orders: DomainReconciliationStats;
      payments: DomainReconciliationStats;
      refunds: DomainReconciliationStats;
      expenses: DomainReconciliationStats;
    };
  }> {
    const { from, to } = this.resolveControlDates(query);
    const limit = Math.min(Math.max(query?.limit ?? 500, 1), 2000);
    const nowIso = new Date().toISOString();
    const findings: ControlFinding[] = [];

    // Helper for tx debit total
    const getTxAmount = (tx: { lines: { debitPaise: number }[] }) =>
      tx.lines.reduce((sum, l) => sum + l.debitPaise, 0);

    // ─────────────────────────────────────────────────────────────────────────
    // A. ORDERS / SALE RECONCILIATION
    // ─────────────────────────────────────────────────────────────────────────
    const orderCreatedAtFilter: { gte?: Date; lte?: Date } = {};
    if (from) orderCreatedAtFilter.gte = from;
    if (to) orderCreatedAtFilter.lte = to;

    const orders = await this.prisma.order.findMany({
      where: {
        AND: [
          from || to ? { createdAt: orderCreatedAtFilter } : {},
          {
            status: { in: ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'] },
          },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orderNumber: true,
        totalAmount: true,
        currency: true,
        status: true,
      },
    });

    const orderIds = orders.map((o) => o.id);

    // Fetch matching POSTED transactions for these orders
    const orderTxs = orderIds.length > 0
      ? await this.prisma.financialTransaction.findMany({
          where: {
            sourceType: FINANCE_SOURCE_TYPES.ORDER,
            sourceId: { in: orderIds },
            status: FinancialTransactionStatus.POSTED,
          },
          include: { lines: true },
        })
      : [];

    const orderTxMap = new Map<string, typeof orderTxs>();
    for (const tx of orderTxs) {
      if (!tx.sourceId) continue;
      const list = orderTxMap.get(tx.sourceId) ?? [];
      list.push(tx);
      orderTxMap.set(tx.sourceId, list);
    }

    const orderStats: DomainReconciliationStats = {
      checked: orders.length,
      matched: 0,
      mismatched: 0,
      missing: 0,
      duplicates: 0,
    };

    for (const order of orders) {
      const txs = orderTxMap.get(order.id) ?? [];
      const expectedCurrency = order.currency ?? 'INR';

      if (txs.length === 0) {
        orderStats.missing++;
        findings.push({
          id: `rec_order_missing_${order.id}`,
          controlType: ControlType.ORDER_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_ORDER_MISSING_TRANSACTION',
          sourceType: FINANCE_SOURCE_TYPES.ORDER,
          sourceId: order.id,
          expectedAmountPaise: order.totalAmount,
          currency: expectedCurrency,
          description: `Order '${order.orderNumber}' (${order.id}) has status '${order.status}' but lacks a POSTED SALE ledger transaction.`,
          detectedAt: nowIso,
        });
      } else if (txs.length > 1) {
        orderStats.duplicates++;
        findings.push({
          id: `rec_order_dup_${order.id}`,
          controlType: ControlType.ORDER_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_ORDER_DUPLICATE_TRANSACTION',
          sourceType: FINANCE_SOURCE_TYPES.ORDER,
          sourceId: order.id,
          expectedAmountPaise: order.totalAmount,
          currency: expectedCurrency,
          description: `Order '${order.orderNumber}' (${order.id}) has ${txs.length} duplicate POSTED SALE transactions.`,
          detectedAt: nowIso,
        });
      } else {
        const tx = txs[0];
        if (!tx) continue;
        const actualAmount = getTxAmount(tx);
        let matched = true;

        if (actualAmount !== order.totalAmount) {
          matched = false;
          findings.push({
            id: `rec_order_amt_${order.id}`,
            controlType: ControlType.ORDER_RECONCILIATION,
            severity: ControlSeverity.CRITICAL,
            ruleCode: 'REC_ORDER_AMOUNT_MISMATCH',
            sourceType: FINANCE_SOURCE_TYPES.ORDER,
            sourceId: order.id,
            transactionId: tx.id,
            expectedAmountPaise: order.totalAmount,
            actualAmountPaise: actualAmount,
            currency: expectedCurrency,
            description: `Order '${order.orderNumber}' amount (${order.totalAmount} paise) does not match ledger transaction amount (${actualAmount} paise).`,
            detectedAt: nowIso,
          });
        }

        if (tx.currency !== expectedCurrency) {
          matched = false;
          findings.push({
            id: `rec_order_curr_${order.id}`,
            controlType: ControlType.ORDER_RECONCILIATION,
            severity: ControlSeverity.WARNING,
            ruleCode: 'REC_ORDER_CURRENCY_MISMATCH',
            sourceType: FINANCE_SOURCE_TYPES.ORDER,
            sourceId: order.id,
            transactionId: tx.id,
            expectedAmountPaise: order.totalAmount,
            actualAmountPaise: actualAmount,
            currency: tx.currency,
            description: `Order '${order.orderNumber}' currency '${expectedCurrency}' does not match ledger transaction currency '${tx.currency}'.`,
            detectedAt: nowIso,
          });
        }

        if (matched) {
          orderStats.matched++;
        } else {
          orderStats.mismatched++;
        }
      }
    }

    // Reverse check for Orders: find POSTED order txs in period and check for orphan source
    const postedOrderTxsInPeriod = await this.prisma.financialTransaction.findMany({
      where: {
        sourceType: FINANCE_SOURCE_TYPES.ORDER,
        status: FinancialTransactionStatus.POSTED,
        ...(from || to ? { postedAt: { gte: from, lte: to } } : {}),
      },
      orderBy: { postedAt: 'desc' },
      take: limit,
      select: { id: true, sourceId: true, currency: true, postedAt: true },
    });

    const candidateOrderIds = Array.from(
      new Set(postedOrderTxsInPeriod.map((t) => t.sourceId).filter((id): id is string => Boolean(id))),
    );
    const existingOrders = candidateOrderIds.length > 0
      ? await this.prisma.order.findMany({
          where: { id: { in: candidateOrderIds } },
          select: { id: true, status: true },
        })
      : [];
    const existingOrderMap = new Map(existingOrders.map((o) => [o.id, o]));

    for (const tx of postedOrderTxsInPeriod) {
      if (!tx.sourceId) {
        findings.push({
          id: `rec_order_null_src_${tx.id}`,
          controlType: ControlType.ORDER_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_INVALID_SOURCE_REFERENCE',
          transactionId: tx.id,
          sourceType: FINANCE_SOURCE_TYPES.ORDER,
          currency: tx.currency,
          description: `Transaction '${tx.id}' has sourceType 'ORDER' but missing sourceId.`,
          detectedAt: nowIso,
        });
        continue;
      }

      const ord = existingOrderMap.get(tx.sourceId);
      if (!ord) {
        findings.push({
          id: `rec_order_orphan_${tx.id}`,
          controlType: ControlType.ORDER_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_INVALID_SOURCE_REFERENCE',
          transactionId: tx.id,
          sourceType: FINANCE_SOURCE_TYPES.ORDER,
          sourceId: tx.sourceId,
          currency: tx.currency,
          description: `Transaction '${tx.id}' references non-existent Order ID '${tx.sourceId}'.`,
          detectedAt: nowIso,
        });
      }
      // Note: Orders with status 'CANCELLED' legitimately retain historical SALE transactions
      // and cancellation reversal entries in double-entry bookkeeping, so they are not treated as unexpected.
    }

    // ─────────────────────────────────────────────────────────────────────────
    // B. PAYMENTS / PAYMENT RECONCILIATION
    // ─────────────────────────────────────────────────────────────────────────
    const payments = await this.prisma.paymentAttempt.findMany({
      where: {
        status: PaymentStatus.CAPTURED,
        ...(from || to ? { createdAt: { gte: from, lte: to } } : {}),
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
      },
    });

    const paymentIds = payments.map((p) => p.id);
    const paymentTxs = paymentIds.length > 0
      ? await this.prisma.financialTransaction.findMany({
          where: {
            sourceType: FINANCE_SOURCE_TYPES.PAYMENT,
            sourceId: { in: paymentIds },
            status: FinancialTransactionStatus.POSTED,
          },
          include: { lines: true },
        })
      : [];

    const paymentTxMap = new Map<string, typeof paymentTxs>();
    for (const tx of paymentTxs) {
      if (!tx.sourceId) continue;
      const list = paymentTxMap.get(tx.sourceId) ?? [];
      list.push(tx);
      paymentTxMap.set(tx.sourceId, list);
    }

    const paymentStats: DomainReconciliationStats = {
      checked: payments.length,
      matched: 0,
      mismatched: 0,
      missing: 0,
      duplicates: 0,
    };

    for (const pay of payments) {
      const txs = paymentTxMap.get(pay.id) ?? [];
      const expectedCurrency = pay.currency ?? 'INR';

      if (txs.length === 0) {
        paymentStats.missing++;
        findings.push({
          id: `rec_pay_missing_${pay.id}`,
          controlType: ControlType.PAYMENT_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_PAYMENT_MISSING_TRANSACTION',
          sourceType: FINANCE_SOURCE_TYPES.PAYMENT,
          sourceId: pay.id,
          expectedAmountPaise: pay.amount,
          currency: expectedCurrency,
          description: `Captured PaymentAttempt '${pay.id}' lacks a POSTED PAYMENT ledger transaction.`,
          detectedAt: nowIso,
        });
      } else if (txs.length > 1) {
        paymentStats.duplicates++;
        findings.push({
          id: `rec_pay_dup_${pay.id}`,
          controlType: ControlType.PAYMENT_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_PAYMENT_DUPLICATE_TRANSACTION',
          sourceType: FINANCE_SOURCE_TYPES.PAYMENT,
          sourceId: pay.id,
          expectedAmountPaise: pay.amount,
          currency: expectedCurrency,
          description: `Captured PaymentAttempt '${pay.id}' has ${txs.length} duplicate POSTED PAYMENT ledger transactions.`,
          detectedAt: nowIso,
        });
      } else {
        const tx = txs[0];
        if (!tx) continue;
        const actualAmount = getTxAmount(tx);
        let matched = true;

        if (actualAmount !== pay.amount) {
          matched = false;
          findings.push({
            id: `rec_pay_amt_${pay.id}`,
            controlType: ControlType.PAYMENT_RECONCILIATION,
            severity: ControlSeverity.CRITICAL,
            ruleCode: 'REC_PAYMENT_AMOUNT_MISMATCH',
            sourceType: FINANCE_SOURCE_TYPES.PAYMENT,
            sourceId: pay.id,
            transactionId: tx.id,
            expectedAmountPaise: pay.amount,
            actualAmountPaise: actualAmount,
            currency: expectedCurrency,
            description: `PaymentAttempt '${pay.id}' amount (${pay.amount} paise) does not match ledger transaction amount (${actualAmount} paise).`,
            detectedAt: nowIso,
          });
        }

        if (tx.currency !== expectedCurrency) {
          matched = false;
          findings.push({
            id: `rec_pay_curr_${pay.id}`,
            controlType: ControlType.PAYMENT_RECONCILIATION,
            severity: ControlSeverity.WARNING,
            ruleCode: 'REC_PAYMENT_CURRENCY_MISMATCH',
            sourceType: FINANCE_SOURCE_TYPES.PAYMENT,
            sourceId: pay.id,
            transactionId: tx.id,
            expectedAmountPaise: pay.amount,
            actualAmountPaise: actualAmount,
            currency: tx.currency,
            description: `PaymentAttempt '${pay.id}' currency '${expectedCurrency}' does not match ledger transaction currency '${tx.currency}'.`,
            detectedAt: nowIso,
          });
        }

        if (matched) {
          paymentStats.matched++;
        } else {
          paymentStats.mismatched++;
        }
      }
    }

    // Reverse check for Payments
    const postedPayTxsInPeriod = await this.prisma.financialTransaction.findMany({
      where: {
        sourceType: FINANCE_SOURCE_TYPES.PAYMENT,
        status: FinancialTransactionStatus.POSTED,
        ...(from || to ? { postedAt: { gte: from, lte: to } } : {}),
      },
      orderBy: { postedAt: 'desc' },
      take: limit,
      select: { id: true, sourceId: true, currency: true },
    });

    const candidatePayIds = Array.from(
      new Set(postedPayTxsInPeriod.map((t) => t.sourceId).filter((id): id is string => Boolean(id))),
    );
    const existingPayments = candidatePayIds.length > 0
      ? await this.prisma.paymentAttempt.findMany({
          where: { id: { in: candidatePayIds } },
          select: { id: true, status: true },
        })
      : [];
    const existingPayMap = new Map(existingPayments.map((p) => [p.id, p]));

    for (const tx of postedPayTxsInPeriod) {
      if (!tx.sourceId) {
        findings.push({
          id: `rec_pay_null_src_${tx.id}`,
          controlType: ControlType.PAYMENT_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_INVALID_SOURCE_REFERENCE',
          transactionId: tx.id,
          sourceType: FINANCE_SOURCE_TYPES.PAYMENT,
          currency: tx.currency,
          description: `Transaction '${tx.id}' has sourceType 'PAYMENT' but missing sourceId.`,
          detectedAt: nowIso,
        });
        continue;
      }

      const pay = existingPayMap.get(tx.sourceId);
      if (!pay) {
        findings.push({
          id: `rec_pay_orphan_${tx.id}`,
          controlType: ControlType.PAYMENT_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_INVALID_SOURCE_REFERENCE',
          transactionId: tx.id,
          sourceType: FINANCE_SOURCE_TYPES.PAYMENT,
          sourceId: tx.sourceId,
          currency: tx.currency,
          description: `Transaction '${tx.id}' references non-existent PaymentAttempt ID '${tx.sourceId}'.`,
          detectedAt: nowIso,
        });
      } else if (pay.status !== PaymentStatus.CAPTURED) {
        findings.push({
          id: `rec_pay_unexp_${tx.id}`,
          controlType: ControlType.PAYMENT_RECONCILIATION,
          severity: ControlSeverity.WARNING,
          ruleCode: 'REC_UNEXPECTED_TRANSACTION',
          transactionId: tx.id,
          sourceType: FINANCE_SOURCE_TYPES.PAYMENT,
          sourceId: tx.sourceId,
          currency: tx.currency,
          description: `Transaction '${tx.id}' exists for uncaptured PaymentAttempt '${tx.sourceId}' (status: ${pay.status}).`,
          detectedAt: nowIso,
        });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // C. REFUNDS / REFUND RECONCILIATION
    // ─────────────────────────────────────────────────────────────────────────
    const refunds = await this.prisma.refund.findMany({
      where: {
        status: RefundStatus.COMPLETED,
        ...(from || to ? { updatedAt: { gte: from, lte: to } } : {}),
      },
      take: limit,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        refundNumber: true,
        amount: true,
        currency: true,
        status: true,
      },
    });

    const refundIds = refunds.map((r) => r.id);
    const refundTxs = refundIds.length > 0
      ? await this.prisma.financialTransaction.findMany({
          where: {
            sourceType: FINANCE_SOURCE_TYPES.REFUND,
            sourceId: { in: refundIds },
            status: FinancialTransactionStatus.POSTED,
          },
          include: { lines: true },
        })
      : [];

    const refundTxMap = new Map<string, typeof refundTxs>();
    for (const tx of refundTxs) {
      if (!tx.sourceId) continue;
      const list = refundTxMap.get(tx.sourceId) ?? [];
      list.push(tx);
      refundTxMap.set(tx.sourceId, list);
    }

    const refundStats: DomainReconciliationStats = {
      checked: refunds.length,
      matched: 0,
      mismatched: 0,
      missing: 0,
      duplicates: 0,
    };

    for (const ref of refunds) {
      const txs = refundTxMap.get(ref.id) ?? [];
      const expectedCurrency = ref.currency ?? 'INR';

      if (txs.length === 0) {
        refundStats.missing++;
        findings.push({
          id: `rec_ref_missing_${ref.id}`,
          controlType: ControlType.REFUND_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_REFUND_MISSING_TRANSACTION',
          sourceType: FINANCE_SOURCE_TYPES.REFUND,
          sourceId: ref.id,
          expectedAmountPaise: ref.amount,
          currency: expectedCurrency,
          description: `Completed Refund '${ref.refundNumber}' (${ref.id}) lacks a POSTED REFUND ledger transaction.`,
          detectedAt: nowIso,
        });
      } else if (txs.length > 1) {
        refundStats.duplicates++;
        findings.push({
          id: `rec_ref_dup_${ref.id}`,
          controlType: ControlType.REFUND_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_REFUND_DUPLICATE_TRANSACTION',
          sourceType: FINANCE_SOURCE_TYPES.REFUND,
          sourceId: ref.id,
          expectedAmountPaise: ref.amount,
          currency: expectedCurrency,
          description: `Completed Refund '${ref.refundNumber}' (${ref.id}) has ${txs.length} duplicate POSTED REFUND transactions.`,
          detectedAt: nowIso,
        });
      } else {
        const tx = txs[0];
        if (!tx) continue;
        const actualAmount = getTxAmount(tx);
        let matched = true;

        if (actualAmount !== ref.amount) {
          matched = false;
          findings.push({
            id: `rec_ref_amt_${ref.id}`,
            controlType: ControlType.REFUND_RECONCILIATION,
            severity: ControlSeverity.CRITICAL,
            ruleCode: 'REC_REFUND_AMOUNT_MISMATCH',
            sourceType: FINANCE_SOURCE_TYPES.REFUND,
            sourceId: ref.id,
            transactionId: tx.id,
            expectedAmountPaise: ref.amount,
            actualAmountPaise: actualAmount,
            currency: expectedCurrency,
            description: `Refund '${ref.refundNumber}' amount (${ref.amount} paise) does not match ledger transaction amount (${actualAmount} paise).`,
            detectedAt: nowIso,
          });
        }

        if (tx.currency !== expectedCurrency) {
          matched = false;
          findings.push({
            id: `rec_ref_curr_${ref.id}`,
            controlType: ControlType.REFUND_RECONCILIATION,
            severity: ControlSeverity.WARNING,
            ruleCode: 'REC_REFUND_CURRENCY_MISMATCH',
            sourceType: FINANCE_SOURCE_TYPES.REFUND,
            sourceId: ref.id,
            transactionId: tx.id,
            expectedAmountPaise: ref.amount,
            actualAmountPaise: actualAmount,
            currency: tx.currency,
            description: `Refund '${ref.refundNumber}' currency '${expectedCurrency}' does not match ledger transaction currency '${tx.currency}'.`,
            detectedAt: nowIso,
          });
        }

        if (matched) {
          refundStats.matched++;
        } else {
          refundStats.mismatched++;
        }
      }
    }

    // Reverse check for Refunds
    const postedRefTxsInPeriod = await this.prisma.financialTransaction.findMany({
      where: {
        sourceType: FINANCE_SOURCE_TYPES.REFUND,
        status: FinancialTransactionStatus.POSTED,
        ...(from || to ? { postedAt: { gte: from, lte: to } } : {}),
      },
      orderBy: { postedAt: 'desc' },
      take: limit,
      select: { id: true, sourceId: true, currency: true },
    });

    const candidateRefIds = Array.from(
      new Set(postedRefTxsInPeriod.map((t) => t.sourceId).filter((id): id is string => Boolean(id))),
    );
    const existingRefunds = candidateRefIds.length > 0
      ? await this.prisma.refund.findMany({
          where: { id: { in: candidateRefIds } },
          select: { id: true, status: true },
        })
      : [];
    const existingRefMap = new Map(existingRefunds.map((r) => [r.id, r]));

    for (const tx of postedRefTxsInPeriod) {
      if (!tx.sourceId) {
        findings.push({
          id: `rec_ref_null_src_${tx.id}`,
          controlType: ControlType.REFUND_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_INVALID_SOURCE_REFERENCE',
          transactionId: tx.id,
          sourceType: FINANCE_SOURCE_TYPES.REFUND,
          currency: tx.currency,
          description: `Transaction '${tx.id}' has sourceType 'REFUND' but missing sourceId.`,
          detectedAt: nowIso,
        });
        continue;
      }

      const ref = existingRefMap.get(tx.sourceId);
      if (!ref) {
        findings.push({
          id: `rec_ref_orphan_${tx.id}`,
          controlType: ControlType.REFUND_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_INVALID_SOURCE_REFERENCE',
          transactionId: tx.id,
          sourceType: FINANCE_SOURCE_TYPES.REFUND,
          sourceId: tx.sourceId,
          currency: tx.currency,
          description: `Transaction '${tx.id}' references non-existent Refund ID '${tx.sourceId}'.`,
          detectedAt: nowIso,
        });
      } else if (ref.status !== RefundStatus.COMPLETED) {
        findings.push({
          id: `rec_ref_unexp_${tx.id}`,
          controlType: ControlType.REFUND_RECONCILIATION,
          severity: ControlSeverity.WARNING,
          ruleCode: 'REC_UNEXPECTED_TRANSACTION',
          transactionId: tx.id,
          sourceType: FINANCE_SOURCE_TYPES.REFUND,
          sourceId: tx.sourceId,
          currency: tx.currency,
          description: `Transaction '${tx.id}' exists for incomplete Refund '${tx.sourceId}' (status: ${ref.status}).`,
          detectedAt: nowIso,
        });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // D. EXPENSES / EXPENSE RECONCILIATION
    // ─────────────────────────────────────────────────────────────────────────
    const expenses = await this.prisma.expense.findMany({
      where: {
        status: ExpenseStatus.POSTED,
        ...(from || to ? { expenseDate: { gte: from, lte: to } } : {}),
      },
      take: limit,
      orderBy: { expenseDate: 'desc' },
      select: {
        id: true,
        expenseNumber: true,
        amountPaise: true,
        currency: true,
        status: true,
      },
    });

    const expenseIds = expenses.map((e) => e.id);
    const expenseTxs = expenseIds.length > 0
      ? await this.prisma.financialTransaction.findMany({
          where: {
            sourceType: FINANCE_SOURCE_TYPES.EXPENSE,
            sourceId: { in: expenseIds },
            status: FinancialTransactionStatus.POSTED,
          },
          include: { lines: true },
        })
      : [];

    const expenseTxMap = new Map<string, typeof expenseTxs>();
    for (const tx of expenseTxs) {
      if (!tx.sourceId) continue;
      const list = expenseTxMap.get(tx.sourceId) ?? [];
      list.push(tx);
      expenseTxMap.set(tx.sourceId, list);
    }

    const expenseStats: DomainReconciliationStats = {
      checked: expenses.length,
      matched: 0,
      mismatched: 0,
      missing: 0,
      duplicates: 0,
    };

    for (const exp of expenses) {
      const txs = expenseTxMap.get(exp.id) ?? [];
      const expectedCurrency = exp.currency ?? 'INR';

      if (txs.length === 0) {
        expenseStats.missing++;
        findings.push({
          id: `rec_exp_missing_${exp.id}`,
          controlType: ControlType.EXPENSE_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_EXPENSE_MISSING_TRANSACTION',
          sourceType: FINANCE_SOURCE_TYPES.EXPENSE,
          sourceId: exp.id,
          expectedAmountPaise: exp.amountPaise,
          currency: expectedCurrency,
          description: `Posted Expense '${exp.expenseNumber}' (${exp.id}) lacks a POSTED EXPENSE ledger transaction.`,
          detectedAt: nowIso,
        });
      } else if (txs.length > 1) {
        expenseStats.duplicates++;
        findings.push({
          id: `rec_exp_dup_${exp.id}`,
          controlType: ControlType.EXPENSE_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_EXPENSE_DUPLICATE_TRANSACTION',
          sourceType: FINANCE_SOURCE_TYPES.EXPENSE,
          sourceId: exp.id,
          expectedAmountPaise: exp.amountPaise,
          currency: expectedCurrency,
          description: `Posted Expense '${exp.expenseNumber}' (${exp.id}) has ${txs.length} duplicate POSTED EXPENSE transactions.`,
          detectedAt: nowIso,
        });
      } else {
        const tx = txs[0];
        if (!tx) continue;
        const actualAmount = getTxAmount(tx);
        let matched = true;

        if (actualAmount !== exp.amountPaise) {
          matched = false;
          findings.push({
            id: `rec_exp_amt_${exp.id}`,
            controlType: ControlType.EXPENSE_RECONCILIATION,
            severity: ControlSeverity.CRITICAL,
            ruleCode: 'REC_EXPENSE_AMOUNT_MISMATCH',
            sourceType: FINANCE_SOURCE_TYPES.EXPENSE,
            sourceId: exp.id,
            transactionId: tx.id,
            expectedAmountPaise: exp.amountPaise,
            actualAmountPaise: actualAmount,
            currency: expectedCurrency,
            description: `Expense '${exp.expenseNumber}' amount (${exp.amountPaise} paise) does not match ledger transaction amount (${actualAmount} paise).`,
            detectedAt: nowIso,
          });
        }

        if (tx.currency !== expectedCurrency) {
          matched = false;
          findings.push({
            id: `rec_exp_curr_${exp.id}`,
            controlType: ControlType.EXPENSE_RECONCILIATION,
            severity: ControlSeverity.WARNING,
            ruleCode: 'REC_EXPENSE_CURRENCY_MISMATCH',
            sourceType: FINANCE_SOURCE_TYPES.EXPENSE,
            sourceId: exp.id,
            transactionId: tx.id,
            expectedAmountPaise: exp.amountPaise,
            actualAmountPaise: actualAmount,
            currency: tx.currency,
            description: `Expense '${exp.expenseNumber}' currency '${expectedCurrency}' does not match ledger transaction currency '${tx.currency}'.`,
            detectedAt: nowIso,
          });
        }

        if (matched) {
          expenseStats.matched++;
        } else {
          expenseStats.mismatched++;
        }
      }
    }

    // Reverse check for Expenses
    const postedExpTxsInPeriod = await this.prisma.financialTransaction.findMany({
      where: {
        sourceType: FINANCE_SOURCE_TYPES.EXPENSE,
        status: FinancialTransactionStatus.POSTED,
        ...(from || to ? { postedAt: { gte: from, lte: to } } : {}),
      },
      orderBy: { postedAt: 'desc' },
      take: limit,
      select: { id: true, sourceId: true, currency: true },
    });

    const candidateExpIds = Array.from(
      new Set(postedExpTxsInPeriod.map((t) => t.sourceId).filter((id): id is string => Boolean(id))),
    );
    const existingExpenses = candidateExpIds.length > 0
      ? await this.prisma.expense.findMany({
          where: { id: { in: candidateExpIds } },
          select: { id: true, status: true },
        })
      : [];
    const existingExpMap = new Map(existingExpenses.map((e) => [e.id, e]));

    for (const tx of postedExpTxsInPeriod) {
      if (!tx.sourceId) {
        findings.push({
          id: `rec_exp_null_src_${tx.id}`,
          controlType: ControlType.EXPENSE_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_INVALID_SOURCE_REFERENCE',
          transactionId: tx.id,
          sourceType: FINANCE_SOURCE_TYPES.EXPENSE,
          currency: tx.currency,
          description: `Transaction '${tx.id}' has sourceType 'EXPENSE' but missing sourceId.`,
          detectedAt: nowIso,
        });
        continue;
      }

      const exp = existingExpMap.get(tx.sourceId);
      if (!exp) {
        findings.push({
          id: `rec_exp_orphan_${tx.id}`,
          controlType: ControlType.EXPENSE_RECONCILIATION,
          severity: ControlSeverity.CRITICAL,
          ruleCode: 'REC_INVALID_SOURCE_REFERENCE',
          transactionId: tx.id,
          sourceType: FINANCE_SOURCE_TYPES.EXPENSE,
          sourceId: tx.sourceId,
          currency: tx.currency,
          description: `Transaction '${tx.id}' references non-existent Expense ID '${tx.sourceId}'.`,
          detectedAt: nowIso,
        });
      } else if (exp.status !== ExpenseStatus.POSTED) {
        findings.push({
          id: `rec_exp_unexp_${tx.id}`,
          controlType: ControlType.EXPENSE_RECONCILIATION,
          severity: ControlSeverity.WARNING,
          ruleCode: 'REC_UNEXPECTED_TRANSACTION',
          transactionId: tx.id,
          sourceType: FINANCE_SOURCE_TYPES.EXPENSE,
          sourceId: tx.sourceId,
          currency: tx.currency,
          description: `Transaction '${tx.id}' exists for unposted Expense '${tx.sourceId}' (status: ${exp.status}).`,
          detectedAt: nowIso,
        });
      }
    }

    return {
      findings,
      domainStats: {
        orders: orderStats,
        payments: paymentStats,
        refunds: refundStats,
        expenses: expenseStats,
      },
    };
  }

  /**
   * 3. COMBINED CONTROLS REPORT
   * Orchestrates both Ledger Integrity and Domain Reconciliations, returning a
   * structured, machine-readable operational diagnostic report.
   */
  async runAllControls(query?: QueryFinanceControlsDto): Promise<FinanceControlsReportDto> {
    const startTime = Date.now();
    const period = this.resolveControlDates(query);

    const [ledgerResult, reconResult] = await Promise.all([
      this.verifyLedgerIntegrity(query),
      this.runDomainReconciliations(query),
    ]);

    const findings = [...ledgerResult.findings, ...reconResult.findings];
    const criticalCount = findings.filter((f) => f.severity === ControlSeverity.CRITICAL).length;
    const warningCount = findings.filter((f) => f.severity === ControlSeverity.WARNING).length;

    const totalDomainItems =
      reconResult.domainStats.orders.checked +
      reconResult.domainStats.payments.checked +
      reconResult.domainStats.refunds.checked +
      reconResult.domainStats.expenses.checked;

    const totalChecks = ledgerResult.stats.transactionsChecked + totalDomainItems;
    const failedCount = findings.length;
    const passedCount = Math.max(0, totalChecks - failedCount);

    const summary: ControlSummary = {
      status: findings.length === 0 ? 'CLEAN' : 'ISSUES_DETECTED',
      totalChecksRun: totalChecks,
      passedCount,
      failedCount,
      criticalCount,
      warningCount,
      ledgerIntegrity: {
        status: ledgerResult.stats.status,
        transactionsChecked: ledgerResult.stats.transactionsChecked,
        violationsCount: ledgerResult.stats.violationsCount,
      },
      domainReconciliations: reconResult.domainStats,
      period: {
        startDate: period.from?.toISOString(),
        endDate: period.to?.toISOString(),
        preset: period.preset,
      },
      executionTimeMs: Date.now() - startTime,
      executedAt: new Date().toISOString(),
    };

    return {
      summary,
      findings,
    };
  }
}
