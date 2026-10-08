import { IsOptional, IsISO8601, IsEnum, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { PeriodPreset } from './finance-reports.dto.js';

export enum ControlSeverity {
  CRITICAL = 'CRITICAL',
  WARNING = 'WARNING',
  INFO = 'INFO',
}

export enum ControlType {
  LEDGER_INTEGRITY = 'LEDGER_INTEGRITY',
  ORDER_RECONCILIATION = 'ORDER_RECONCILIATION',
  PAYMENT_RECONCILIATION = 'PAYMENT_RECONCILIATION',
  REFUND_RECONCILIATION = 'REFUND_RECONCILIATION',
  EXPENSE_RECONCILIATION = 'EXPENSE_RECONCILIATION',
}

export class QueryFinanceControlsDto {
  @IsOptional()
  @IsISO8601()
  startDate?: string;

  @IsOptional()
  @IsISO8601()
  endDate?: string;

  @IsOptional()
  @IsEnum(PeriodPreset)
  period?: PeriodPreset;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit?: number = 500;
}

export interface ControlFinding {
  id: string;
  controlType: ControlType;
  severity: ControlSeverity;
  ruleCode: string;
  sourceType?: string;
  sourceId?: string;
  transactionId?: string;
  expectedAmountPaise?: number;
  actualAmountPaise?: number;
  currency?: string;
  description: string;
  detectedAt: string;
}

export interface DomainReconciliationStats {
  checked: number;
  matched: number;
  mismatched: number;
  missing: number;
  duplicates: number;
}

export interface ControlSummary {
  status: 'CLEAN' | 'ISSUES_DETECTED';
  totalChecksRun: number;
  passedCount: number;
  failedCount: number;
  criticalCount: number;
  warningCount: number;
  ledgerIntegrity: {
    status: 'PASSED' | 'FAILED';
    transactionsChecked: number;
    violationsCount: number;
  };
  domainReconciliations: {
    orders: DomainReconciliationStats;
    payments: DomainReconciliationStats;
    refunds: DomainReconciliationStats;
    expenses: DomainReconciliationStats;
  };
  period: {
    startDate?: string;
    endDate?: string;
    preset?: string;
  };
  executionTimeMs: number;
  executedAt: string;
}

export interface FinanceControlsReportDto {
  summary: ControlSummary;
  findings: ControlFinding[];
}
