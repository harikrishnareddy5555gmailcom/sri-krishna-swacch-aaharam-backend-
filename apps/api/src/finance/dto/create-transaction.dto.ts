import {
  IsNotEmpty,
  IsString,
  IsEnum,
  IsOptional,
  IsInt,
  Min,
  IsArray,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FinancialTransactionType } from '@prisma/client';

export class CreateTransactionLineDto {
  @IsString()
  @IsNotEmpty()
  accountId!: string;

  @IsInt()
  @Min(0)
  @Type(() => Number)
  debitPaise: number = 0;

  @IsInt()
  @Min(0)
  @Type(() => Number)
  creditPaise: number = 0;

  @IsString()
  @IsOptional()
  description?: string;
}

export class CreateFinancialTransactionDto {
  @IsEnum(FinancialTransactionType)
  transactionType!: FinancialTransactionType;

  @IsString()
  @IsOptional()
  currency?: string = 'INR';

  @IsString()
  @IsOptional()
  sourceType?: string;

  @IsString()
  @IsOptional()
  sourceId?: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;

  @IsArray()
  @ArrayMinSize(2, { message: 'A financial transaction must contain at least 2 lines' })
  @ValidateNested({ each: true })
  @Type(() => CreateTransactionLineDto)
  lines!: CreateTransactionLineDto[];
}
