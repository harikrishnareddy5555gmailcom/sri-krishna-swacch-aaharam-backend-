import {
  IsString,
  IsNotEmpty,
  IsArray,
  ValidateNested,
  IsInt,
  Min,
  IsOptional,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateShipmentItemInputDto {
  @IsString()
  @IsNotEmpty()
  orderItemId: string;

  @IsInt()
  @Min(1)
  quantity: number;
}

export class CreateShipmentDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateShipmentItemInputDto)
  items: CreateShipmentItemInputDto[];

  @IsString()
  @IsOptional()
  carrierCode?: string;

  @IsString()
  @IsOptional()
  carrierName?: string;

  @IsString()
  @IsOptional()
  serviceType?: string;

  @IsString()
  @IsOptional()
  trackingNumber?: string;

  @IsString()
  @IsOptional()
  providerShipmentId?: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  weightGrams?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  lengthCm?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  widthCm?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  heightCm?: number;

  @IsBoolean()
  @IsOptional()
  isCod?: boolean;

  @IsInt()
  @Min(0)
  @IsOptional()
  codAmountPaise?: number;

  @IsString()
  @IsOptional()
  labelUrl?: string;

  @IsString()
  @IsOptional()
  manifestUrl?: string;

  @IsString()
  @IsOptional()
  invoiceId?: string;

  @IsString()
  @IsOptional()
  idempotencyKey?: string;
}
