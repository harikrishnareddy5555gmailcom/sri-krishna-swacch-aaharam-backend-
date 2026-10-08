import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Google OAuth Authentication DTO
 */
export class GoogleAuthDto {
  @ApiProperty({ description: 'Google OAuth ID Token or Credential from Google Identity Services' })
  @IsString()
  @IsNotEmpty({ message: 'Google ID token is required' })
  idToken!: string;
}
