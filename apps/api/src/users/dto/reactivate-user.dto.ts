import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ReactivateUserDto {
  @ApiPropertyOptional({
    example: 'Identity verified; account restored to active standing',
    description: 'Operational rationale for reactivating the account',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Reason must not exceed 500 characters' })
  reason?: string;
}
