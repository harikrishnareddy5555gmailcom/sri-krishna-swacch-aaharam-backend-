import { IsInt, Min, Max } from 'class-validator';
import { DEFAULT_MAX_CART_ITEM_QUANTITY, type UpdateCartItemDto } from '@vishkaraa/types';

export class UpdateCartItemRequestDto implements UpdateCartItemDto {
  @IsInt({ message: 'quantity must be an integer' })
  @Min(1, { message: 'quantity must be at least 1' })
  @Max(DEFAULT_MAX_CART_ITEM_QUANTITY, {
    message: `quantity cannot exceed ${DEFAULT_MAX_CART_ITEM_QUANTITY}`,
  })
  quantity!: number;
}
