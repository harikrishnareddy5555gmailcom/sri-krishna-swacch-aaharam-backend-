import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsInt,
  IsUUID,
  IsBoolean,
  Min,
  MaxLength,
} from 'class-validator';
import { MediaType } from '@vishkaraa/types';
import { IsValidMediaUrl } from '../validators/media-url.validator.js';

export class CreateMediaValidationDto {
  /**
   * Fully-resolved URL for the media file.
   * Provider credentials must NOT be embedded here.
   * Must be a valid public HTTPS URL and cannot target internal/private network addresses (anti-SSRF).
   */
  @IsString()
  @IsNotEmpty()
  @IsValidMediaUrl()
  @MaxLength(2000)
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  altText?: string;

  @IsOptional()
  @IsEnum(MediaType)
  mediaType?: MediaType;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsUUID()
  variantId?: string;
}
