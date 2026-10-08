import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CancelInvoiceDto {
  @IsString()
  @IsNotEmpty({ message: 'Cancellation reason is required' })
  @MaxLength(500, { message: 'Cancellation reason cannot exceed 500 characters' })
  reason!: string;
}
