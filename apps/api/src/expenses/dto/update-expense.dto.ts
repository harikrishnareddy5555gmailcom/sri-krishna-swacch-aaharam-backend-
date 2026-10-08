import {
  IsString,
  IsInt,
  IsPositive,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsDateString,
} from 'class-validator';
import { ExpensePaymentMethod } from '@prisma/client';

export class UpdateExpenseDto {
  @IsString()
  @IsOptional()
  category?: string;

  @IsString()
  @IsOptional()
  vendor?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @IsPositive()
  @IsOptional()
  amountPaise?: number;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsDateString()
  @IsOptional()
  expenseDate?: string;

  @IsString()
  @IsOptional()
  expenseAccountId?: string;

  @IsBoolean()
  @IsOptional()
  isPaid?: boolean;

  @IsEnum(ExpensePaymentMethod)
  @IsOptional()
  paymentMethod?: ExpensePaymentMethod;

  @IsString()
  @IsOptional()
  paymentReference?: string;

  @IsDateString()
  @IsOptional()
  paymentDate?: string;

  @IsString()
  @IsOptional()
  receiptUrl?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}
