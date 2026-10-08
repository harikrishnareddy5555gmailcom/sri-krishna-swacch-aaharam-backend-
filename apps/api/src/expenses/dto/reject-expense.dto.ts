import { IsNotEmpty, IsString } from 'class-validator';

export class RejectExpenseDto {
  @IsString()
  @IsNotEmpty()
  rejectionReason!: string;
}
