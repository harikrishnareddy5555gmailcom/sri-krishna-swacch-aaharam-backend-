import { IsNotEmpty, IsString, IsEnum, IsOptional, Matches } from 'class-validator';
import { FinancialAccountType, FinancialAccountNormalBalance } from '@prisma/client';

export class CreateFinancialAccountDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z0-9_-]{3,20}$/, {
    message: 'Account code must be 3-20 characters long and contain only uppercase letters, numbers, hyphens, and underscores',
  })
  code!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsEnum(FinancialAccountType)
  type!: FinancialAccountType;

  @IsEnum(FinancialAccountNormalBalance)
  normalBalance!: FinancialAccountNormalBalance;

  @IsString()
  @IsOptional()
  description?: string;
}
