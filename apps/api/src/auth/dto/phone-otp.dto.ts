import { IsString, IsNotEmpty, Matches, IsOptional, Length, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Request Phone OTP DTO
 */
export class RequestPhoneOtpDto {
  @ApiProperty({ example: '9876543210', description: '10-digit mobile number or with +91 country code' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^(\+?91)?[6-9]\d{9}$/, {
    message: 'Please provide a valid 10-digit Indian mobile number',
  })
  phone!: string;
}

/**
 * Verify Phone OTP DTO
 */
export class VerifyPhoneOtpDto {
  @ApiProperty({ example: '9876543210', description: '10-digit mobile number or with +91 country code' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^(\+?91)?[6-9]\d{9}$/, {
    message: 'Please provide a valid 10-digit Indian mobile number',
  })
  phone!: string;

  @ApiProperty({ example: '123456', description: '6-digit OTP code', required: false })
  @IsOptional()
  @IsString()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  otp?: string;

  @ApiProperty({ description: 'Firebase Phone Auth ID Token (if verified via Firebase Web SDK)', required: false })
  @IsOptional()
  @IsString()
  idToken?: string;

  @ApiProperty({ example: 'Ravi', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  firstName?: string;

  @ApiProperty({ example: 'Kumar', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  lastName?: string;
}
