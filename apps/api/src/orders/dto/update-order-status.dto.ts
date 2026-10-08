import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { OrderStatus } from '@vishkaraa/types';

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus, { message: 'Invalid order status' })
  @IsNotEmpty()
  status!: OrderStatus;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string;
}
