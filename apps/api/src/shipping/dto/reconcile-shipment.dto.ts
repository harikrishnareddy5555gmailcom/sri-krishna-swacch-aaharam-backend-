import { IsEnum, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import { ShipmentStatus } from '@prisma/client';

export class ReconcileShipmentDto {
  @IsOptional()
  @IsEnum(ShipmentStatus)
  targetStatus?: ShipmentStatus;

  @IsNotEmpty()
  @IsString()
  @MinLength(5)
  notes!: string;
}
