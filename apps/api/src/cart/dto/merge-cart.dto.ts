import { IsString, IsNotEmpty, Length } from 'class-validator';
import type { MergeCartDto } from '@vishkaraa/types';

export class MergeCartRequestDto implements MergeCartDto {
  @IsString({ message: 'guestToken must be a string' })
  @IsNotEmpty({ message: 'guestToken is required' })
  @Length(32, 128, { message: 'guestToken must be between 32 and 128 characters' })
  guestToken!: string;
}
