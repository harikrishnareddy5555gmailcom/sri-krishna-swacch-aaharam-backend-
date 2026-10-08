import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Login DTO
 * Validated by global ValidationPipe using class-validator decorators.
 * Ensures only sanitized, well-formed credentials reach authentication strategies.
 */
export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email!: string;

  @ApiProperty({ example: 'SecurePassword123' })
  @IsString()
  @MinLength(1, { message: 'Password is required' })
  password!: string;
}
