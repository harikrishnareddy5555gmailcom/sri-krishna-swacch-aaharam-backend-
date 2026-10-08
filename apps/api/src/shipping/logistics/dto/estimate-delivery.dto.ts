import {
  IsString,
  IsNotEmpty,
  Matches,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsBoolean,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class EstimateDeliveryDto {
  @ApiProperty({ example: '560034', description: '6-digit Indian PIN Code' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[1-9]\d{5}$/, { message: 'PIN code must be a valid 6-digit Indian postal code' })
  pincode!: string;

  @ApiProperty({ example: 1000, description: 'Package weight in grams', required: false, default: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  weightGrams?: number;

  @ApiProperty({ example: false, description: 'True for wholesale bulk/B2B shipments', required: false, default: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isBulk?: boolean;
}

export class CreateCourierPartnerDto {
  @ApiProperty({ example: 'Delhivery Express' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'DELHIVERY' })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ example: 1, required: false })
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  isSurfaceHeavy?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  apiCredentials?: Record<string, unknown>;
}

export class UpdateCourierPartnerDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isSurfaceHeavy?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  apiCredentials?: Record<string, unknown>;
}

export class CreateRateCardDto {
  @ApiProperty({ example: 'courier-partner-uuid' })
  @IsString()
  @IsNotEmpty()
  courierId!: string;

  @ApiProperty({ example: 0 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minWeightKg!: number;

  @ApiProperty({ example: 5 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  maxWeightKg!: number;

  @ApiProperty({ example: 60 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  baseRate!: number;

  @ApiProperty({ example: 25 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  perKgRate!: number;

  @ApiProperty({ example: 3 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedTransitDays!: number;
}

export class CreateBlacklistedPincodeDto {
  @ApiProperty({ example: '799001' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[1-9]\d{5}$/, { message: 'PIN code must be a valid 6-digit Indian postal code' })
  pincode!: string;

  @ApiProperty({ example: 'Severe flooding / logistics route closure' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
