import {
  IsOptional,
  IsString,
  MaxLength,
  Length,
  ValidateNested,
  IsNotEmpty,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DEFAULT_MAX_CART_ITEM_QUANTITY } from '@vishkaraa/types';

/**
 * Validated shipping address input for checkout sessions.
 */
export class ShippingAddressDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  line1!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  line2?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  state!: string;

  @IsString()
  @IsNotEmpty()
  @Length(6, 6)
  postalCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  country?: string;
}

/**
 * Buy Now single-item direct purchase payload.
 * Strictly validated: client cannot supply prices, totals, or discounts.
 */
export class BuyNowItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  productId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  productVariantId!: string;

  @IsInt()
  @Min(1)
  @Max(DEFAULT_MAX_CART_ITEM_QUANTITY, {
    message: `quantity must be between 1 and ${DEFAULT_MAX_CART_ITEM_QUANTITY}`,
  })
  quantity!: number;
}

export class InitializeCheckoutDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;

  /** Optional shipping address — stored on CheckoutSession for later Order finalization. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shippingAddress?: ShippingAddressDto;

  /** Optional Buy Now item for direct checkout without mutating the customer's active cart. */
  @IsOptional()
  @ValidateNested()
  @Type(() => BuyNowItemDto)
  buyNowItem?: BuyNowItemDto;
}

