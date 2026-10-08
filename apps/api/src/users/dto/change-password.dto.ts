import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({ example: 'CurrentSecure123', description: 'Existing account password' })
  @IsString()
  @MinLength(1, { message: 'Current password is required' })
  currentPassword!: string;

  @ApiProperty({ example: 'NewSecurePassword123', description: 'New password meeting complexity policy' })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128, { message: 'Password must not exceed 128 characters' })
  @Matches(/[A-Z]/, {
    message: 'Password must contain at least one uppercase letter',
  })
  @Matches(/[a-z]/, {
    message: 'Password must contain at least one lowercase letter',
  })
  @Matches(/\d/, { message: 'Password must contain at least one number' })
  newPassword!: string;
}
