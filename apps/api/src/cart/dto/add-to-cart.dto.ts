import { IsUUID, IsInt, Min, Max } from 'class-validator';
import { DEFAULT_MAX_CART_ITEM_QUANTITY, type AddToCartDto } from '@vishkaraa/types';

export class AddToCartRequestDto implements AddToCartDto {
  @IsUUID('4', { message: 'productId must be a valid UUID' })
  productId!: string;

  @IsUUID('4', { message: 'productVariantId must be a valid UUID' })
  productVariantId!: string;

  @IsInt({ message: 'quantity must be an integer' })
  @Min(1, { message: 'quantity must be at least 1' })
  @Max(DEFAULT_MAX_CART_ITEM_QUANTITY, {
    message: `quantity cannot exceed ${DEFAULT_MAX_CART_ITEM_QUANTITY}`,
  })
  quantity!: number;
}
