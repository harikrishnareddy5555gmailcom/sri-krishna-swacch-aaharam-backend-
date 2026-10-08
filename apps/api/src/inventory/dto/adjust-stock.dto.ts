import { IsInt, IsNotEmpty, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class AdjustStockDto {
  @IsInt()
  @IsNotEmpty()
  delta!: number;

  @IsString()
  @MinLength(5)
  @IsNotEmpty()
  reason!: string;

  @IsString()
  @MinLength(3)
  @IsNotEmpty()
  idempotencyKey!: string;
}

export class StockIncreaseBodyDto {
  @IsInt()
  @Min(1)
  @IsNotEmpty()
  quantity!: number;

  @IsString()
  @MinLength(5)
  @IsNotEmpty()
  reason!: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  idempotencyKey?: string;
}

export class StockDecreaseBodyDto {
  @IsInt()
  @Min(1)
  @IsNotEmpty()
  quantity!: number;

  @IsString()
  @MinLength(5)
  @IsNotEmpty()
  reason!: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  idempotencyKey?: string;
}
