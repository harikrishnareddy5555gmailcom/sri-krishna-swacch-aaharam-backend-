import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsEnum,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import { AddressLabel } from '@prisma/client';

function trimString({ value }: TransformFnParams): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function trimUpperString({ value }: TransformFnParams): string | undefined {
  return typeof value === 'string' ? value.trim().toUpperCase() : undefined;
}

export class CreateAddressDto {
  @ApiPropertyOptional({
    example: 'John Doe',
    description: 'Recipient contact name',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString({ message: 'Recipient name must be a string' })
  @MaxLength(100, { message: 'Recipient name must not exceed 100 characters' })
  recipientName?: string;

  @ApiPropertyOptional({
    example: 'John Doe',
    description: 'Recipient contact name (alias for recipientName)',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Full name must not exceed 100 characters' })
  fullName?: string;

  @ApiPropertyOptional({
    example: '+919876543210',
    description: 'Contact phone number',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString({ message: 'Phone number must be a string' })
  @MinLength(7, { message: 'Phone number must be at least 7 digits' })
  @MaxLength(20, { message: 'Phone number must not exceed 20 characters' })
  phone?: string;

  @ApiPropertyOptional({
    example: '+919876543210',
    description: 'Contact phone number (alias for phone)',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MinLength(7, { message: 'Phone number must be at least 7 digits' })
  @MaxLength(20, { message: 'Phone number must not exceed 20 characters' })
  phoneNumber?: string;

  @ApiPropertyOptional({
    example: '42 Orchid Heights, 3rd Floor',
    description: 'Primary street address line',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString({ message: 'Address line 1 must be a string' })
  @MaxLength(255, { message: 'Address line 1 must not exceed 255 characters' })
  line1?: string;

  @ApiPropertyOptional({
    example: '42 Orchid Heights, 3rd Floor',
    description: 'Primary street address line (alias for line1)',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'Address line 1 must not exceed 255 characters' })
  addressLine1?: string;

  @ApiPropertyOptional({
    example: 'Opposite Central Park',
    description: 'Secondary street or suite/flat line',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString({ message: 'Address line 2 must be a string' })
  @MaxLength(255, { message: 'Address line 2 must not exceed 255 characters' })
  line2?: string;

  @ApiPropertyOptional({
    example: 'Opposite Central Park',
    description: 'Secondary street or suite/flat line (alias for line2)',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'Address line 2 must not exceed 255 characters' })
  addressLine2?: string;

  @ApiProperty({
    example: 'Bengaluru',
    description: 'City or district',
  })
  @Transform(trimString)
  @IsString({ message: 'City must be a string' })
  @IsNotEmpty({ message: 'City is required' })
  @MinLength(1, { message: 'City must not be empty' })
  @MaxLength(100, { message: 'City must not exceed 100 characters' })
  city!: string;

  @ApiProperty({
    example: 'Karnataka',
    description: 'State, province, or region',
  })
  @Transform(trimString)
  @IsString({ message: 'State must be a string' })
  @IsNotEmpty({ message: 'State is required' })
  @MinLength(1, { message: 'State must not be empty' })
  @MaxLength(100, { message: 'State must not exceed 100 characters' })
  state!: string;

  @ApiProperty({
    example: '560001',
    description: 'Postal or PIN code',
  })
  @Transform(trimString)
  @IsString({ message: 'Postal code must be a string' })
  @IsNotEmpty({ message: 'Postal code is required' })
  @MinLength(3, { message: 'Postal code must be at least 3 characters' })
  @MaxLength(20, { message: 'Postal code must not exceed 20 characters' })
  postalCode!: string;

  @ApiPropertyOptional({
    example: 'IN',
    default: 'IN',
    description: 'Country code or name',
  })
  @Transform(trimUpperString)
  @IsOptional()
  @IsString({ message: 'Country must be a string' })
  @MaxLength(100, { message: 'Country must not exceed 100 characters' })
  country?: string;

  @ApiPropertyOptional({
    example: 'Near Metro Pillar 120',
    description: 'Nearby landmark for courier delivery',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString({ message: 'Landmark must be a string' })
  @MaxLength(255, { message: 'Landmark must not exceed 255 characters' })
  landmark?: string;

  @ApiPropertyOptional({
    enum: AddressLabel,
    default: AddressLabel.HOME,
    example: AddressLabel.HOME,
    description: 'Address label: HOME, WORK, or OTHER',
  })
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string'
      ? (value.trim().toUpperCase() as AddressLabel)
      : undefined,
  )
  @IsOptional()
  @IsEnum(AddressLabel, {
    message: 'Label must be one of: HOME, WORK, OTHER',
  })
  label?: AddressLabel;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description: 'Mark this address as the default delivery destination',
  })
  @IsOptional()
  @IsBoolean({ message: 'isDefault must be a boolean' })
  isDefault?: boolean;
}
