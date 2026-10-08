import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class CancelShipmentDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(3, { message: 'Cancellation reason must be at least 3 characters' })
  reason: string;
}
