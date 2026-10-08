import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';

import type { Request } from 'express';
import { ExpensesService } from './expenses.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { FeaturesGuard } from '../auth/guards/features.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequireFeatures } from '../auth/decorators/features.decorator.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';
import { FeatureKey, Permissions } from '@vishkaraa/types';
import { CreateExpenseDto } from './dto/create-expense.dto.js';
import { UpdateExpenseDto } from './dto/update-expense.dto.js';
import { RejectExpenseDto } from './dto/reject-expense.dto.js';
import { CancelExpenseDto } from './dto/cancel-expense.dto.js';
import { QueryExpensesDto } from './dto/query-expenses.dto.js';
import { AddExpenseAttachmentDto } from './dto/add-attachment.dto.js';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    role: string;
    email: string;
  };
}

@Controller('admin/expenses')
@UseGuards(JwtAuthGuard, FeaturesGuard, PermissionsGuard)
@RequireFeatures(FeatureKey.EXPENSES)
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Post()
  @RequirePermissions(Permissions.EXPENSES_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async createExpense(
    @Body() dto: CreateExpenseDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.expensesService.createExpense(dto, req.user.id);
  }

  @Get()
  @RequirePermissions(Permissions.EXPENSES_VIEW)
  async listExpenses(@Query() query: QueryExpensesDto) {
    return this.expensesService.listExpenses(query);
  }

  @Get('accounts')
  @RequirePermissions(Permissions.EXPENSES_VIEW)
  async getExpenseAccounts() {
    return this.expensesService.getExpenseAccounts();
  }

  @Get(':id')
  @RequirePermissions(Permissions.EXPENSES_VIEW)
  async getExpense(@Param('id') id: string) {
    return this.expensesService.getExpenseById(id);
  }

  @Patch(':id')
  @RequirePermissions(Permissions.EXPENSES_UPDATE)
  async updateExpense(
    @Param('id') id: string,
    @Body() dto: UpdateExpenseDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.expensesService.updateExpense(id, dto, req.user.id);
  }

  @Post(':id/submit')
  @RequirePermissions(Permissions.EXPENSES_SUBMIT)
  @HttpCode(HttpStatus.OK)
  async submitExpense(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.expensesService.submitExpense(id, req.user.id);
  }

  @Post(':id/approve')
  @RequirePermissions(Permissions.EXPENSES_APPROVE)
  @HttpCode(HttpStatus.OK)
  async approveExpense(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.expensesService.approveExpense(id, req.user.id, req.user.role);
  }

  @Post(':id/reject')
  @RequirePermissions(Permissions.EXPENSES_REJECT)
  @HttpCode(HttpStatus.OK)
  async rejectExpense(
    @Param('id') id: string,
    @Body() dto: RejectExpenseDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.expensesService.rejectExpense(id, dto, req.user.id, req.user.role);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permissions.EXPENSES_CANCEL)
  @HttpCode(HttpStatus.OK)
  async cancelExpense(
    @Param('id') id: string,
    @Body() dto: CancelExpenseDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.expensesService.cancelExpense(id, dto, req.user.id, req.user.role);
  }

  @Post(':id/post')
  @RequirePermissions(Permissions.EXPENSES_POST)
  @HttpCode(HttpStatus.OK)
  async postExpense(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.expensesService.postExpense(id, req.user.id, req.user.role);
  }

  @Post(':id/attachments')
  @RequirePermissions(Permissions.EXPENSES_UPDATE)
  @HttpCode(HttpStatus.CREATED)
  async addAttachment(
    @Param('id') id: string,
    @Body() dto: AddExpenseAttachmentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.expensesService.addAttachment(id, dto, req.user.id);
  }

  @Delete(':id/attachments/:attachmentId')
  @RequirePermissions(Permissions.EXPENSES_UPDATE)
  @HttpCode(HttpStatus.OK)
  async deleteAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.expensesService.deleteAttachment(id, attachmentId, req.user.id, req.user.role);
  }
}

