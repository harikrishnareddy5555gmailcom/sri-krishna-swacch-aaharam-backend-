import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma, Expense, ExpenseAttachment, ExpenseStatus } from '@prisma/client';

export type ExpenseWithRelations = Expense & {
  attachments?: ExpenseAttachment[];
};

@Injectable()
export class ExpensesRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient): PrismaService | Prisma.TransactionClient {
    return tx ?? this.prisma;
  }

  async transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }

  async createExpense(
    data: Prisma.ExpenseCreateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Expense> {
    return this.getClient(tx).expense.create({
      data,
      include: { attachments: true },
    });
  }

  async updateExpense(
    id: string,
    data: Prisma.ExpenseUpdateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Expense> {
    return this.getClient(tx).expense.update({
      where: { id },
      data,
      include: { attachments: true },
    });
  }

  async updateExpenseWithStatusPredicate(
    id: string,
    expectedStatus: ExpenseStatus | ExpenseStatus[],
    data: Prisma.ExpenseUpdateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<ExpenseWithRelations | null> {
    const statusCondition = Array.isArray(expectedStatus)
      ? { in: expectedStatus }
      : expectedStatus;

    const result = await this.getClient(tx).expense.updateMany({
      where: {
        id,
        status: statusCondition,
      },
      data,
    });

    if (result.count === 0) {
      return null;
    }

    return this.findExpenseById(id, tx);
  }


  async findExpenseById(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ExpenseWithRelations | null> {
    return this.getClient(tx).expense.findUnique({
      where: { id },
      include: {
        attachments: true,
        expenseAccount: true,
      },
    });
  }

  async findExpenseByNumber(
    expenseNumber: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ExpenseWithRelations | null> {
    return this.getClient(tx).expense.findUnique({
      where: { expenseNumber },
      include: {
        attachments: true,
        expenseAccount: true,
      },
    });
  }

  async listExpenses(
    params: {
      status?: ExpenseStatus;
      category?: string;
      vendor?: string;
      search?: string;
      startDate?: Date;
      endDate?: Date;
      minAmountPaise?: number;
      maxAmountPaise?: number;
      skip?: number;
      take?: number;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<ExpenseWithRelations[]> {
    const where: Prisma.ExpenseWhereInput = {};

    if (params.status) {
      where.status = params.status;
    }
    if (params.category) {
      where.category = { contains: params.category, mode: 'insensitive' };
    }
    if (params.vendor) {
      where.vendor = { contains: params.vendor, mode: 'insensitive' };
    }
    if (params.startDate || params.endDate) {
      where.expenseDate = {
        ...(params.startDate ? { gte: params.startDate } : {}),
        ...(params.endDate ? { lte: params.endDate } : {}),
      };
    }
    if (params.minAmountPaise !== undefined || params.maxAmountPaise !== undefined) {
      where.amountPaise = {
        ...(params.minAmountPaise !== undefined ? { gte: params.minAmountPaise } : {}),
        ...(params.maxAmountPaise !== undefined ? { lte: params.maxAmountPaise } : {}),
      };
    }
    if (params.search) {
      where.OR = [
        { expenseNumber: { contains: params.search, mode: 'insensitive' } },
        { vendor: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
        { category: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    return this.getClient(tx).expense.findMany({
      where,
      skip: params.skip,
      take: params.take,
      orderBy: [
        { expenseDate: 'desc' },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      include: {
        attachments: true,
        expenseAccount: true,
      },
    });
  }

  async countExpenses(
    params: {
      status?: ExpenseStatus;
      category?: string;
      vendor?: string;
      search?: string;
      startDate?: Date;
      endDate?: Date;
      minAmountPaise?: number;
      maxAmountPaise?: number;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const where: Prisma.ExpenseWhereInput = {};

    if (params.status) {
      where.status = params.status;
    }
    if (params.category) {
      where.category = { contains: params.category, mode: 'insensitive' };
    }
    if (params.vendor) {
      where.vendor = { contains: params.vendor, mode: 'insensitive' };
    }
    if (params.startDate || params.endDate) {
      where.expenseDate = {
        ...(params.startDate ? { gte: params.startDate } : {}),
        ...(params.endDate ? { lte: params.endDate } : {}),
      };
    }
    if (params.minAmountPaise !== undefined || params.maxAmountPaise !== undefined) {
      where.amountPaise = {
        ...(params.minAmountPaise !== undefined ? { gte: params.minAmountPaise } : {}),
        ...(params.maxAmountPaise !== undefined ? { lte: params.maxAmountPaise } : {}),
      };
    }
    if (params.search) {
      where.OR = [
        { expenseNumber: { contains: params.search, mode: 'insensitive' } },
        { vendor: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
        { category: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    return this.getClient(tx).expense.count({ where });
  }

  async addAttachment(
    expenseId: string,
    data: {
      fileName: string;
      fileUrl: string;
      fileSize?: number;
      mimeType?: string;
      uploadedById: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<ExpenseAttachment> {
    return this.getClient(tx).expenseAttachment.create({
      data: {
        expenseId,
        fileName: data.fileName,
        fileUrl: data.fileUrl,
        fileSize: data.fileSize,
        mimeType: data.mimeType,
        uploadedById: data.uploadedById,
      },
    });
  }

  async findAttachmentById(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ExpenseAttachment | null> {
    return this.getClient(tx).expenseAttachment.findUnique({
      where: { id },
    });
  }

  async deleteAttachment(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ExpenseAttachment> {
    return this.getClient(tx).expenseAttachment.delete({
      where: { id },
    });
  }
}

