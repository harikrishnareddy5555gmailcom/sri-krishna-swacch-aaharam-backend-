import {
  IsOptional,
  IsISO8601,
  IsEnum,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  FinancialAccountType,
  FinancialAccountNormalBalance,
  FinancialTransactionType,
} from '@prisma/client';

export enum PeriodPreset {
  ALL_TIME = 'all_time',
  DAILY = 'daily',
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  FISCAL_YEAR = 'fiscal_year',
  CUSTOM = 'custom',
}

export class QueryFinancialReportDto {
  @IsOptional()
  @IsISO8601()
  startDate?: string;

  @IsOptional()
  @IsISO8601()
  endDate?: string;

  @IsOptional()
  @IsEnum(PeriodPreset)
  period?: PeriodPreset;
}

export class QueryAccountDrillDownDto extends QueryFinancialReportDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number = 20;
}

export interface AccountSummary {
  id: string;
  code: string;
  name: string;
  type: FinancialAccountType;
  normalBalance: FinancialAccountNormalBalance;
}

export interface TrialBalanceItem {
  account: AccountSummary;
  totalDebitPaise: number;
  totalCreditPaise: number;
  balancePaise: number;
}

export interface TrialBalanceReport {
  asOf: string;
  period: {
    startDate?: string;
    endDate?: string;
    preset?: PeriodPreset;
  };
  accounts: TrialBalanceItem[];
  totalDebitPaise: number;
  totalCreditPaise: number;
  isBalanced: boolean;
}

export interface IncomeStatementAccountItem {
  account: AccountSummary;
  totalDebitPaise: number;
  totalCreditPaise: number;
  balancePaise: number;
}

export interface ProfitLossReport {
  period: {
    startDate: string;
    endDate: string;
    preset?: PeriodPreset;
  };
  revenue: {
    accounts: IncomeStatementAccountItem[];
    totalRevenuePaise: number;
  };
  expenses: {
    accounts: IncomeStatementAccountItem[];
    totalExpensePaise: number;
  };
  netIncomePaise: number;
  isProfitable: boolean;
}

export interface BalanceSheetAccountItem {
  account: AccountSummary;
  totalDebitPaise: number;
  totalCreditPaise: number;
  balancePaise: number;
}

export interface BalanceSheetReport {
  asOf: string;
  period: {
    startDate?: string;
    endDate?: string;
    preset?: PeriodPreset;
  };
  assets: {
    accounts: BalanceSheetAccountItem[];
    totalAssetsPaise: number;
  };
  liabilities: {
    accounts: BalanceSheetAccountItem[];
    totalLiabilitiesPaise: number;
  };
  equity: {
    accounts: BalanceSheetAccountItem[];
    totalEquityPaise: number;
  };
  totalLiabilitiesAndEquityPaise: number;
  balanceDifferencePaise: number;
  currentPeriodNetIncomePaise: number;
  reconciliationNote: string;
  isBalanced: boolean;
}

export interface AccountDrillDownEntry {
  id: string;
  transactionId: string;
  transactionType: FinancialTransactionType;
  sourceType: string | null;
  sourceId: string | null;
  description: string | null;
  postedAt: string | null;
  debitPaise: number;
  creditPaise: number;
}

export interface AccountDrillDownReport {
  account: AccountSummary;
  period: {
    startDate?: string;
    endDate?: string;
  };
  openingBalancePaise: number;
  periodDebitPaise: number;
  periodCreditPaise: number;
  closingBalancePaise: number;
  entries: AccountDrillDownEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ExecutiveReconciliationItem {
  orderId: string;
  orderNumber: string;
  customerName?: string;
  customerEmail?: string;
  status: string;
  totalAmountPaise: number;
  paymentCapturedPaise: number;
  refundDeductedPaise: number;
  netRealizedPaise: number;
  createdAt: string;
}

export interface ExpenseCategorySummary {
  category: string;
  amountPaise: number;
  count: number;
  percentage: number;
}

export interface ExecutiveSummaryMetrics {
  totalOrdersCount: number;
  grossOrderVolumePaise: number;
  cancelledOrdersCount: number;
  cancelledAmountPaise: number;
  completedRefundsCount: number;
  refundedAmountPaise: number;
  totalDeductionsPaise: number;
  completedOrdersCount: number;
  netRealizedRevenuePaise: number;
  totalExpensesPaise: number;
  pendingApprovalExpensesPaise: number;
  approvedExpensesPaise: number;
  postedExpensesPaise: number;
  expensesCount: number;
  netProfitPaise: number;
  netProfitMarginPercent: number;
  isProfitable: boolean;
  cashInBankPaise: number;
  accountsPayablePaise: number;
}

export interface WaterfallStep {
  label: string;
  amountPaise: number;
  type: 'positive' | 'negative' | 'subtotal' | 'total';
}

export interface ExecutiveSummaryReport {
  period: {
    startDate?: string;
    endDate?: string;
    preset?: PeriodPreset;
  };
  metrics: ExecutiveSummaryMetrics;
  expenseBreakdown: ExpenseCategorySummary[];
  recentReconciliation: ExecutiveReconciliationItem[];
  waterfallSteps: WaterfallStep[];
}
