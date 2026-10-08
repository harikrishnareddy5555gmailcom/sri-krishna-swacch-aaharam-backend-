import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { FinanceService } from './finance.service.js';
import { FinanceExportService } from './finance-export.service.js';
import { FinanceControlsService } from './finance-controls.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { FeaturesGuard } from '../auth/guards/features.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequireFeatures } from '../auth/decorators/features.decorator.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';
import { FeatureKey, Permissions } from '@vishkaraa/types';
import {
  CreateFinancialAccountDto,
  CreateFinancialTransactionDto,
  QueryFinancialTransactionsDto,
  CompensatingTransactionDto,
  QueryFinancialReportDto,
  QueryAccountDrillDownDto,
  QueryFinanceControlsDto,
} from './dto/index.js';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    role: string;
    email: string;
  };
}

function getExportDateString(): string {
  const parts = new Date().toISOString().split('T');
  return parts[0] ?? '';
}

/**
 * Admin Finance Controller — Phase 15A, 16A, 16B & 16C
 *
 * Gated by centralized FeaturesGuard, PermissionsGuard and explicit permission checks:
 * - FINANCE.VIEW for viewing chart of accounts, transactions, balances, trial balance, P&L, balance sheet, exports, and controls
 * - FINANCE.POST for posting transactions and compensating reversals
 * - FINANCE.MANAGE for account creation, deactivation, and reactivation
 */
@Controller('admin/finance')
@UseGuards(JwtAuthGuard, FeaturesGuard, PermissionsGuard)
@RequireFeatures(FeatureKey.FINANCE)
export class AdminFinanceController {
  constructor(
    private readonly financeService: FinanceService,
    private readonly financeExportService: FinanceExportService,
    private readonly financeControlsService: FinanceControlsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Account Endpoints
  // ---------------------------------------------------------------------------

  @Get('accounts')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async listAccounts(
    @Query('isActive') isActive?: string,
    @Query('type') type?: string,
  ) {
    const activeFilter =
      isActive === 'true' ? true : isActive === 'false' ? false : undefined;
    return this.financeService.listAccounts({ isActive: activeFilter, type });
  }

  @Get('accounts/:id')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async getAccount(@Param('id') id: string) {
    return this.financeService.getAccountById(id);
  }

  @Get('accounts/:id/balance')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async getAccountBalance(@Param('id') id: string) {
    return this.financeService.getAccountBalance(id);
  }

  @Post('accounts')
  @RequirePermissions(Permissions.FINANCE_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  async createAccount(
    @Body() dto: CreateFinancialAccountDto,
    @Req() req: Request,
  ) {
    const actorId = (req as AuthenticatedRequest).user.id;
    return this.financeService.createAccount(dto, actorId);
  }

  @Patch('accounts/:id/deactivate')
  @RequirePermissions(Permissions.FINANCE_MANAGE)
  async deactivateAccount(@Param('id') id: string, @Req() req: Request) {
    const actorId = (req as AuthenticatedRequest).user.id;
    return this.financeService.deactivateAccount(id, actorId);
  }

  @Patch('accounts/:id/reactivate')
  @RequirePermissions(Permissions.FINANCE_MANAGE)
  async reactivateAccount(@Param('id') id: string, @Req() req: Request) {
    const actorId = (req as AuthenticatedRequest).user.id;
    return this.financeService.reactivateAccount(id, actorId);
  }

  // ---------------------------------------------------------------------------
  // Transaction Endpoints
  // ---------------------------------------------------------------------------

  @Get('transactions')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async listTransactions(@Query() query: QueryFinancialTransactionsDto) {
    return this.financeService.listTransactions(query);
  }

  @Get('transactions/:id')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async getTransaction(@Param('id') id: string) {
    return this.financeService.getTransactionById(id);
  }

  @Post('transactions')
  @RequirePermissions(Permissions.FINANCE_POST)
  @HttpCode(HttpStatus.CREATED)
  async postTransaction(
    @Body() dto: CreateFinancialTransactionDto,
    @Req() req: Request,
  ) {
    const actorId = (req as AuthenticatedRequest).user.id;
    return this.financeService.postTransaction(dto, actorId);
  }

  @Post('transactions/:id/compensate')
  @RequirePermissions(Permissions.FINANCE_POST)
  @HttpCode(HttpStatus.CREATED)
  async compensateTransaction(
    @Param('id') id: string,
    @Body() dto: CompensatingTransactionDto,
    @Req() req: Request,
  ) {
    const actorId = (req as AuthenticatedRequest).user.id;
    return this.financeService.createCompensatingTransaction(id, dto, actorId);
  }

  // ---------------------------------------------------------------------------
  // Reporting & Statements Endpoints (Phase 16A)
  // ---------------------------------------------------------------------------

  @Get('reports/trial-balance')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async getTrialBalanceReport(@Query() query: QueryFinancialReportDto) {
    return this.financeService.getTrialBalanceReport(query);
  }

  @Get('reports/profit-loss')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async getProfitLossReport(@Query() query: QueryFinancialReportDto) {
    return this.financeService.getProfitLossReport(query);
  }

  @Get('reports/executive-summary')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async getExecutiveSummaryReport(@Query() query: QueryFinancialReportDto) {
    return this.financeService.getExecutiveSummaryReport(query);
  }

  @Get('reports/balance-sheet')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async getBalanceSheetReport(@Query() query: QueryFinancialReportDto) {
    return this.financeService.getBalanceSheetReport(query);
  }

  @Get('reports/accounts/:accountId')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async getAccountDrillDown(
    @Param('accountId') accountId: string,
    @Query() query: QueryAccountDrillDownDto,
  ) {
    return this.financeService.getAccountDrillDown(accountId, query);
  }

  // ---------------------------------------------------------------------------
  // Reporting & Statements Exports (Phase 16B)
  // ---------------------------------------------------------------------------

  @Get('reports/trial-balance/csv')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async exportTrialBalanceCsv(
    @Query() query: QueryFinancialReportDto,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.financeService.getTrialBalanceReport(query);
    const csv = this.financeExportService.generateTrialBalanceCsv(report);
    const filename = `trial-balance-${getExportDateString()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.send(csv);
  }

  @Get('reports/trial-balance/pdf')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async exportTrialBalancePdf(
    @Query() query: QueryFinancialReportDto,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.financeService.getTrialBalanceReport(query);
    const pdfBuffer = await this.financeExportService.generateTrialBalancePdf(report);
    const filename = `trial-balance-${getExportDateString()}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.end(pdfBuffer);
  }

  @Get('reports/profit-loss/csv')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async exportProfitLossCsv(
    @Query() query: QueryFinancialReportDto,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.financeService.getProfitLossReport(query);
    const csv = this.financeExportService.generateProfitLossCsv(report);
    const filename = `profit-loss-${getExportDateString()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.send(csv);
  }

  @Get('reports/profit-loss/pdf')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async exportProfitLossPdf(
    @Query() query: QueryFinancialReportDto,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.financeService.getProfitLossReport(query);
    const pdfBuffer = await this.financeExportService.generateProfitLossPdf(report);
    const filename = `profit-loss-${getExportDateString()}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.end(pdfBuffer);
  }

  @Get('reports/balance-sheet/csv')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async exportBalanceSheetCsv(
    @Query() query: QueryFinancialReportDto,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.financeService.getBalanceSheetReport(query);
    const csv = this.financeExportService.generateBalanceSheetCsv(report);
    const filename = `balance-sheet-${getExportDateString()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.send(csv);
  }

  @Get('reports/balance-sheet/pdf')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async exportBalanceSheetPdf(
    @Query() query: QueryFinancialReportDto,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.financeService.getBalanceSheetReport(query);
    const pdfBuffer = await this.financeExportService.generateBalanceSheetPdf(report);
    const filename = `balance-sheet-${getExportDateString()}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.end(pdfBuffer);
  }

  @Get('reports/accounts/:accountId/csv')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async exportAccountDrillDownCsv(
    @Param('accountId') accountId: string,
    @Query() query: QueryAccountDrillDownDto,
    @Res() res: Response,
  ): Promise<void> {
    const exportQuery: QueryAccountDrillDownDto = {
      ...query,
      limit: query.limit ?? 1000,
      page: query.page ?? 1,
    };
    const report = await this.financeService.getAccountDrillDown(accountId, exportQuery);
    const csv = this.financeExportService.generateAccountDrillDownCsv(report);
    const safeCode = report.account.code.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `account-drill-down-${safeCode}-${getExportDateString()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.send(csv);
  }

  // ---------------------------------------------------------------------------
  // Financial Controls & Integrity Endpoints (Phase 16C)
  // ---------------------------------------------------------------------------

  @Get('controls')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async getControlsReport(@Query() query: QueryFinanceControlsDto) {
    return this.financeControlsService.runAllControls(query);
  }

  @Get('controls/ledger-integrity')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async getLedgerIntegrityCheck(@Query() query: QueryFinanceControlsDto) {
    return this.financeControlsService.verifyLedgerIntegrity(query);
  }

  @Get('controls/reconciliations')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async getDomainReconciliations(@Query() query: QueryFinanceControlsDto) {
    return this.financeControlsService.runDomainReconciliations(query);
  }

  // ---------------------------------------------------------------------------
  // Backward-Compatible Reporting Primitive
  // ---------------------------------------------------------------------------

  @Get('trial-balance')
  @RequirePermissions(Permissions.FINANCE_VIEW)
  async getTrialBalance() {
    return this.financeService.getTrialBalance();
  }
}

