import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength, IsEnum } from 'class-validator';
import { UserRole } from '@vishkaraa/types';

export class AdminUpdateUserDto {
  @ApiPropertyOptional({ example: 'John', description: 'Updated first name' })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'First name must not be empty' })
  @MaxLength(100, { message: 'First name must not exceed 100 characters' })
  firstName?: string;

  @ApiPropertyOptional({ example: 'Doe', description: 'Updated last name' })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'Last name must not be empty' })
  @MaxLength(100, { message: 'Last name must not exceed 100 characters' })
  lastName?: string;

  @ApiPropertyOptional({ enum: UserRole, description: 'Role assignment (Super Admin only)' })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}

