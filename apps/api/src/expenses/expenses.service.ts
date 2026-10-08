import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { ExpenseStatus, Expense, FinancialAccount } from '@prisma/client';
import { ExpensesRepository, ExpenseWithRelations } from './expenses.repository.js';
import { FinanceService } from '../finance/finance.service.js';
import { AuditService } from '../audit/audit.service.js';
import { validateSafeMediaUrl } from '../catalog/validators/media-url.validator.js';
import { CreateExpenseDto } from './dto/create-expense.dto.js';
import { UpdateExpenseDto } from './dto/update-expense.dto.js';
import { RejectExpenseDto } from './dto/reject-expense.dto.js';
import { CancelExpenseDto } from './dto/cancel-expense.dto.js';
import { QueryExpensesDto } from './dto/query-expenses.dto.js';
import { AddExpenseAttachmentDto } from './dto/add-attachment.dto.js';


@Injectable()
export class ExpensesService {
  private readonly logger = new Logger(ExpensesService.name);

  constructor(
    private readonly expensesRepo: ExpensesRepository,
    private readonly financeService: FinanceService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Generates a deterministic, collision-resistant expense number.
   * Format: EXP-YYYYMM-XXXXXXXX (8 hex chars)
   */
  private generateExpenseNumber(): string {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const randomHex = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `EXP-${yearMonth}-${randomHex}`;
  }

  async createExpense(dto: CreateExpenseDto, actorId: string): Promise<Expense> {
    if (dto.amountPaise <= 0) {
      throw new BadRequestException('Expense amount must be a positive integer in paise.');
    }

    if (dto.expenseAccountId) {
      await this.financeService.validateExpenseAccount(dto.expenseAccountId);
    }

    let expenseNumber = this.generateExpenseNumber();
    let attempts = 0;
    while (attempts < 5) {
      const existing = await this.expensesRepo.findExpenseByNumber(expenseNumber);
      if (!existing) break;
      expenseNumber = this.generateExpenseNumber();
      attempts++;
    }

    const created = await this.expensesRepo.createExpense({
      expenseNumber,
      status: ExpenseStatus.DRAFT,
      category: dto.category.trim(),
      vendor: dto.vendor.trim(),
      description: dto.description.trim(),
      amountPaise: dto.amountPaise,
      currency: dto.currency ?? 'INR',
      expenseDate: new Date(dto.expenseDate),
      isPaid: dto.isPaid ?? true,
      paymentMethod: dto.paymentMethod,
      paymentReference: dto.paymentReference,
      paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : null,
      receiptUrl: dto.receiptUrl,
      notes: dto.notes,
      submittedById: actorId,
      ...(dto.expenseAccountId
        ? { expenseAccount: { connect: { id: dto.expenseAccountId } } }
        : {}),
    });

    await this.auditService.logEvent({
      actorId,
      actorRole: 'ADMIN',
      action: 'EXPENSE_CREATED',
      entityType: 'EXPENSE',
      entityId: created.id,
      amount: created.amountPaise,
      currency: created.currency,
      metadata: {
        expenseNumber: created.expenseNumber,
        category: created.category,
        vendor: created.vendor,
        status: created.status,
      },
    });

    return created;
  }


  async updateExpense(
    id: string,
    dto: UpdateExpenseDto,
    actorId: string,
  ): Promise<ExpenseWithRelations> {
    const expense = await this.expensesRepo.findExpenseById(id);
    if (!expense) {
      throw new NotFoundException(`Expense with ID '${id}' not found.`);
    }

    if (expense.status !== ExpenseStatus.DRAFT) {
      throw new BadRequestException(
        `Cannot update expense in '${expense.status}' status. Only DRAFT expenses may be updated.`,
      );
    }

    if (dto.amountPaise !== undefined && dto.amountPaise <= 0) {
      throw new BadRequestException('Expense amount must be a positive integer in paise.');
    }

    if (dto.expenseAccountId) {
      await this.financeService.validateExpenseAccount(dto.expenseAccountId);
    }


    const updated = await this.expensesRepo.updateExpense(id, {
      ...(dto.category ? { category: dto.category.trim() } : {}),
      ...(dto.vendor ? { vendor: dto.vendor.trim() } : {}),
      ...(dto.description ? { description: dto.description.trim() } : {}),
      ...(dto.amountPaise !== undefined ? { amountPaise: dto.amountPaise } : {}),
      ...(dto.currency ? { currency: dto.currency } : {}),
      ...(dto.expenseDate ? { expenseDate: new Date(dto.expenseDate) } : {}),
      ...(dto.isPaid !== undefined ? { isPaid: dto.isPaid } : {}),
      ...(dto.paymentMethod !== undefined ? { paymentMethod: dto.paymentMethod } : {}),
      ...(dto.paymentReference !== undefined ? { paymentReference: dto.paymentReference } : {}),
      ...(dto.paymentDate !== undefined
        ? { paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : null }
        : {}),
      ...(dto.receiptUrl !== undefined ? { receiptUrl: dto.receiptUrl } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      ...(dto.expenseAccountId !== undefined
        ? dto.expenseAccountId
          ? { expenseAccount: { connect: { id: dto.expenseAccountId } } }
          : { expenseAccount: { disconnect: true } }
        : {}),
    });

    await this.auditService.logEvent({
      actorId,
      actorRole: 'ADMIN',
      action: 'EXPENSE_UPDATED',
      entityType: 'EXPENSE',
      entityId: updated.id,
      amount: updated.amountPaise,
      currency: updated.currency,
      metadata: {
        expenseNumber: updated.expenseNumber,
        status: updated.status,
      },
    });

    return updated;
  }

  async submitExpense(id: string, actorId: string): Promise<ExpenseWithRelations> {
    const expense = await this.expensesRepo.findExpenseById(id);
    if (!expense) {
      throw new NotFoundException(`Expense with ID '${id}' not found.`);
    }

    if (expense.status !== ExpenseStatus.DRAFT) {
      throw new BadRequestException(
        `Cannot submit expense in '${expense.status}' status. Only DRAFT expenses can be submitted.`,
      );
    }

    const updated = await this.expensesRepo.updateExpenseWithStatusPredicate(
      id,
      ExpenseStatus.DRAFT,
      {
        status: ExpenseStatus.SUBMITTED,
        submittedById: actorId,
        submittedAt: new Date(),
      },
    );

    if (!updated) {
      const current = await this.expensesRepo.findExpenseById(id);
      throw new BadRequestException(
        `Cannot submit expense in '${current?.status}' status. Only DRAFT expenses can be submitted.`,
      );
    }

    await this.auditService.logEvent({
      actorId,
      actorRole: 'ADMIN',
      action: 'EXPENSE_SUBMITTED',
      entityType: 'EXPENSE',
      entityId: updated.id,
      amount: updated.amountPaise,
      currency: updated.currency,
      metadata: {
        expenseNumber: updated.expenseNumber,
        status: updated.status,
      },
    });

    return updated;
  }

  async approveExpense(
    id: string,
    actorId: string,
    actorRole?: string,
  ): Promise<ExpenseWithRelations> {
    const expense = await this.expensesRepo.findExpenseById(id);
    if (!expense) {
      throw new NotFoundException(`Expense with ID '${id}' not found.`);
    }

    if (expense.status !== ExpenseStatus.SUBMITTED) {
      throw new BadRequestException(
        `Cannot approve expense in '${expense.status}' status. Only SUBMITTED expenses can be approved.`,
      );
    }

    // Separation of duties: Submitter cannot approve their own expense, unless SUPER_ADMIN override
    if (expense.submittedById === actorId && actorRole !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Separation of duties violation: The submitter cannot approve their own expense.',
      );
    }

    const updated = await this.expensesRepo.updateExpenseWithStatusPredicate(
      id,
      ExpenseStatus.SUBMITTED,
      {
        status: ExpenseStatus.APPROVED,
        approvedById: actorId,
        approvedAt: new Date(),
      },
    );

    if (!updated) {
      const current = await this.expensesRepo.findExpenseById(id);
      throw new BadRequestException(
        `Cannot approve expense in '${current?.status}' status. Only SUBMITTED expenses can be approved.`,
      );
    }

    await this.auditService.logEvent({
      actorId,
      actorRole: actorRole ?? 'ADMIN',
      action: 'EXPENSE_APPROVED',
      entityType: 'EXPENSE',
      entityId: updated.id,
      amount: updated.amountPaise,
      currency: updated.currency,
      metadata: {
        expenseNumber: updated.expenseNumber,
        status: updated.status,
      },
    });

    return updated;
  }

  async rejectExpense(
    id: string,
    dto: RejectExpenseDto,
    actorId: string,
    actorRole?: string,
  ): Promise<ExpenseWithRelations> {
    const expense = await this.expensesRepo.findExpenseById(id);
    if (!expense) {
      throw new NotFoundException(`Expense with ID '${id}' not found.`);
    }

    if (expense.status !== ExpenseStatus.SUBMITTED) {
      throw new BadRequestException(
        `Cannot reject expense in '${expense.status}' status. Only SUBMITTED expenses can be rejected.`,
      );
    }

    const updated = await this.expensesRepo.updateExpenseWithStatusPredicate(
      id,
      ExpenseStatus.SUBMITTED,
      {
        status: ExpenseStatus.REJECTED,
        rejectedById: actorId,
        rejectedAt: new Date(),
        rejectionReason: dto.rejectionReason.trim(),
      },
    );

    if (!updated) {
      const current = await this.expensesRepo.findExpenseById(id);
      throw new BadRequestException(
        `Cannot reject expense in '${current?.status}' status. Only SUBMITTED expenses can be rejected.`,
      );
    }

    await this.auditService.logEvent({
      actorId,
      actorRole: actorRole ?? 'ADMIN',
      action: 'EXPENSE_REJECTED',
      entityType: 'EXPENSE',
      entityId: updated.id,
      amount: updated.amountPaise,
      currency: updated.currency,
      metadata: {
        expenseNumber: updated.expenseNumber,
        status: updated.status,
        rejectionReason: dto.rejectionReason,
      },
    });

    return updated;
  }

  async cancelExpense(
    id: string,
    dto: CancelExpenseDto,
    actorId: string,
    actorRole?: string,
  ): Promise<ExpenseWithRelations> {
    const expense = await this.expensesRepo.findExpenseById(id);
    if (!expense) {
      throw new NotFoundException(`Expense with ID '${id}' not found.`);
    }

    if (expense.status === ExpenseStatus.POSTED) {
      throw new BadRequestException(
        'Cannot cancel a POSTED expense. Posted expenses are financially immutable.',
      );
    }

    if (expense.status === ExpenseStatus.CANCELLED || expense.status === ExpenseStatus.REJECTED) {
      throw new BadRequestException(
        `Expense is already in terminal state '${expense.status}'.`,
      );
    }

    const updated = await this.expensesRepo.updateExpenseWithStatusPredicate(
      id,
      [ExpenseStatus.DRAFT, ExpenseStatus.SUBMITTED, ExpenseStatus.APPROVED],
      {
        status: ExpenseStatus.CANCELLED,
        cancelledById: actorId,
        cancelledAt: new Date(),
        cancellationReason: dto.cancellationReason.trim(),
      },
    );

    if (!updated) {
      const current = await this.expensesRepo.findExpenseById(id);
      throw new BadRequestException(
        `Cannot cancel expense in '${current?.status}' status.`,
      );
    }

    await this.auditService.logEvent({
      actorId,
      actorRole: actorRole ?? 'ADMIN',
      action: 'EXPENSE_CANCELLED',
      entityType: 'EXPENSE',
      entityId: updated.id,
      amount: updated.amountPaise,
      currency: updated.currency,
      metadata: {
        expenseNumber: updated.expenseNumber,
        status: updated.status,
        cancellationReason: dto.cancellationReason,
      },
    });

    return updated;
  }

  /**
   * Posts an approved expense to the double-entry financial ledger.
   *
   * Guaranteed atomicity:
   * State update to POSTED + FinancialTransaction creation + Audit event
   * execute inside a single PostgreSQL transaction.
   *
   * If ledger posting fails, the entire transaction rolls back cleanly.
   */
  async postExpense(
    id: string,
    actorId: string,
    actorRole?: string,
  ): Promise<ExpenseWithRelations> {
    return this.expensesRepo.transaction(async (tx) => {
      // 1. Fetch within transaction to ensure up-to-date status
      const expense = await this.expensesRepo.findExpenseById(id, tx);
      if (!expense) {
        throw new NotFoundException(`Expense with ID '${id}' not found.`);
      }

      // Idempotency: If already POSTED, return safe no-op
      if (expense.status === ExpenseStatus.POSTED) {
        this.logger.log(`Expense ${expense.expenseNumber} is already POSTED — returning idempotent record`);
        return expense;
      }

      if (expense.status !== ExpenseStatus.APPROVED) {
        throw new BadRequestException(
          `Cannot post expense in '${expense.status}' status. Only APPROVED expenses can be posted to the ledger.`,
        );
      }

      // 2. Post financial transaction via FinanceService
      const financeTx = await this.financeService.postExpenseInTransaction(
        {
          id: expense.id,
          expenseNumber: expense.expenseNumber,
          amountPaise: expense.amountPaise,
          currency: expense.currency,
          description: expense.description,
          expenseAccountId: expense.expenseAccountId,
          isPaid: expense.isPaid,
        },
        tx,
        actorId,
      );

      // 3. Update expense status to POSTED
      const updated = await this.expensesRepo.updateExpense(
        id,
        {
          status: ExpenseStatus.POSTED,
          postedById: actorId,
          postedAt: new Date(),
          financeTransactionId: financeTx.id,
        },
        tx,
      );

      // 4. Log Audit Event
      await this.auditService.logEvent({
        actorId,
        actorRole: actorRole ?? 'ADMIN',
        action: 'EXPENSE_POSTED',
        entityType: 'EXPENSE',
        entityId: updated.id,
        amount: updated.amountPaise,
        currency: updated.currency,
        metadata: {
          expenseNumber: updated.expenseNumber,
          status: updated.status,
          financeTransactionId: financeTx.id,
        },
      }, tx);

      return updated;
    });
  }

  async getExpenseById(id: string): Promise<ExpenseWithRelations> {
    const expense = await this.expensesRepo.findExpenseById(id);
    if (!expense) {
      throw new NotFoundException(`Expense with ID '${id}' not found.`);
    }
    return expense;
  }

  async getExpenseAccounts(): Promise<FinancialAccount[]> {
    return this.financeService.getActiveExpenseAccounts();
  }

  async listExpenses(query: QueryExpensesDto): Promise<{
    items: ExpenseWithRelations[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const skip = (page - 1) * limit;

    const startDate = query.startDate ? new Date(query.startDate) : undefined;
    const endDate = query.endDate ? new Date(query.endDate) : undefined;

    const filterParams = {
      status: query.status,
      category: query.category,
      vendor: query.vendor,
      search: query.search,
      startDate,
      endDate,
      minAmountPaise: query.minAmountPaise,
      maxAmountPaise: query.maxAmountPaise,
    };

    const [items, total] = await Promise.all([
      this.expensesRepo.listExpenses({ ...filterParams, skip, take: limit }),
      this.expensesRepo.countExpenses(filterParams),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  async addAttachment(
    id: string,
    dto: AddExpenseAttachmentDto,
    actorId: string,
  ) {
    const expense = await this.expensesRepo.findExpenseById(id);
    if (!expense) {
      throw new NotFoundException(`Expense with ID '${id}' not found.`);
    }

    if (expense.status !== ExpenseStatus.DRAFT && expense.status !== ExpenseStatus.SUBMITTED) {
      throw new BadRequestException(
        `Cannot add attachment to expense in '${expense.status}' status. Attachments can only be modified in DRAFT or SUBMITTED status.`,
      );
    }

    const fileName = dto.fileName.trim();
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      throw new BadRequestException('Invalid fileName: Path traversal characters are not allowed.');
    }

    const extMatch = fileName.match(/\.([a-zA-Z0-9]+)$/);
    const ext = extMatch && extMatch[1] ? `.${extMatch[1].toLowerCase()}` : '';

    const allowedExtensions = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
    if (!allowedExtensions.includes(ext)) {
      throw new BadRequestException(
        `Disallowed file extension '${ext}'. Allowed extensions: ${allowedExtensions.join(', ')}`,
      );
    }

    const disallowedExecutable = [
      '.exe', '.sh', '.bat', '.cmd', '.bin', '.js', '.ts', '.php', '.py',
      '.dll', '.com', '.vbs', '.msi', '.ps1', '.html', '.htm', '.svg',
    ];
    if (disallowedExecutable.includes(ext)) {
      throw new BadRequestException(`Executable or dangerous files are forbidden: '${ext}'`);
    }

    const MAX_SIZE = 10 * 1024 * 1024; // 10MB
    if (dto.fileSize !== undefined && (dto.fileSize <= 0 || dto.fileSize > MAX_SIZE)) {
      throw new BadRequestException(`File size must be positive and <= 10MB (${MAX_SIZE} bytes).`);
    }

    const allowedMime = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (dto.mimeType && !allowedMime.includes(dto.mimeType.toLowerCase())) {
      throw new BadRequestException(
        `Disallowed MIME type '${dto.mimeType}'. Allowed MIME types: ${allowedMime.join(', ')}`,
      );
    }

    if (!validateSafeMediaUrl(dto.fileUrl)) {
      throw new BadRequestException(
        'File URL must be a valid public URL and cannot target internal or loopback IP addresses (anti-SSRF).',
      );
    }

    const attachment = await this.expensesRepo.addAttachment(id, {
      fileName,
      fileUrl: dto.fileUrl.trim(),
      fileSize: dto.fileSize,
      mimeType: dto.mimeType,
      uploadedById: actorId,
    });

    await this.auditService.logEvent({
      actorId,
      actorRole: 'ADMIN',
      action: 'EXPENSE_ATTACHMENT_ADDED',
      entityType: 'EXPENSE',
      entityId: expense.id,
      metadata: {
        attachmentId: attachment.id,
        fileName: attachment.fileName,
      },
    });

    return attachment;
  }

  async deleteAttachment(
    expenseId: string,
    attachmentId: string,
    actorId: string,
    actorRole?: string,
  ): Promise<{ success: boolean; id: string }> {
    const expense = await this.expensesRepo.findExpenseById(expenseId);
    if (!expense) {
      throw new NotFoundException(`Expense with ID '${expenseId}' not found.`);
    }

    if (expense.status !== ExpenseStatus.DRAFT && expense.status !== ExpenseStatus.SUBMITTED) {
      throw new BadRequestException(
        `Cannot remove attachment from expense in '${expense.status}' status. Attachments can only be modified in DRAFT or SUBMITTED status.`,
      );
    }

    const attachment = await this.expensesRepo.findAttachmentById(attachmentId);
    if (!attachment || attachment.expenseId !== expenseId) {
      throw new NotFoundException(`Attachment with ID '${attachmentId}' not found for expense '${expenseId}'.`);
    }

    await this.expensesRepo.deleteAttachment(attachmentId);

    await this.auditService.logEvent({
      actorId,
      actorRole: actorRole ?? 'ADMIN',
      action: 'EXPENSE_ATTACHMENT_REMOVED',
      entityType: 'EXPENSE',
      entityId: expense.id,
      metadata: {
        attachmentId,
        fileName: attachment.fileName,
      },
    });

    return { success: true, id: attachmentId };
  }
}

