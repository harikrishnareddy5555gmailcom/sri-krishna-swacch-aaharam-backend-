import { IsEnum, IsInt, IsOptional, IsString, Max, Min, IsBoolean } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ShipmentStatus } from '@prisma/client';

export class AdminListShipmentsQueryDto {
  @IsEnum(ShipmentStatus)
  @IsOptional()
  status?: ShipmentStatus;

  @IsString()
  @IsOptional()
  carrierCode?: string;

  @IsString()
  @IsOptional()
  provider?: string;

  @IsString()
  @IsOptional()
  trackingNumber?: string;

  @IsString()
  @IsOptional()
  orderId?: string;

  @IsString()
  @IsOptional()
  userId?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsBoolean()
  reconciliationRequired?: boolean;

  @IsString()
  @IsOptional()
  startDate?: string;

  @IsString()
  @IsOptional()
  endDate?: string;

  @IsString()
  @IsOptional()
  search?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  @Type(() => Number)
  limit?: number = 20;
}

export class ShippingQueryDto extends AdminListShipmentsQueryDto {}

