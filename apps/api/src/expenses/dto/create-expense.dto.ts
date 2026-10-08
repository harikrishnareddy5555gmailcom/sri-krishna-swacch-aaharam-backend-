import {
  IsNotEmpty,
  IsString,
  IsInt,
  IsPositive,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsDateString,
} from 'class-validator';
import { ExpensePaymentMethod } from '@prisma/client';

export class CreateExpenseDto {
  @IsString()
  @IsNotEmpty()
  category!: string;

  @IsString()
  @IsNotEmpty()
  vendor!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsInt()
  @IsPositive()
  amountPaise!: number;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsDateString()
  @IsNotEmpty()
  expenseDate!: string;

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
