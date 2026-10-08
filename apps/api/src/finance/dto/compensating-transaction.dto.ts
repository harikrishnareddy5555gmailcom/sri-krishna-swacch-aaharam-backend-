import { IsNotEmpty, IsString } from 'class-validator';

export class CompensatingTransactionDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;
}
