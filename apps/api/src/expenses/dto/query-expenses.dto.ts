import { IsOptional, IsEnum, IsString, IsInt, Min, Max, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';
import { ExpenseStatus } from '@prisma/client';

export class QueryExpensesDto {
  @IsEnum(ExpenseStatus)
  @IsOptional()
  status?: ExpenseStatus;

  @IsString()
  @IsOptional()
  category?: string;

  @IsString()
  @IsOptional()
  vendor?: string;

  @IsString()
  @IsOptional()
  search?: string;

  @IsDateString()
  @IsOptional()
  startDate?: string;

  @IsDateString()
  @IsOptional()
  endDate?: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  minAmountPaise?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  maxAmountPaise?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  @Type(() => Number)
  limit?: number = 50;
}

