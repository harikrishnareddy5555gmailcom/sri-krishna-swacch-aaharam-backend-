import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreatePaymentAttemptDto {
  @IsString()
  @IsNotEmpty()
  checkoutSessionId!: string;

  @IsString()
  @IsOptional()
  idempotencyKey?: string;

  @IsBoolean()
  @IsOptional()
  resetActive?: boolean;
}
