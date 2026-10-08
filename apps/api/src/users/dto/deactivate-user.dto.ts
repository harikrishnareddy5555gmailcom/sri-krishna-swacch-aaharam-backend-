import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class DeactivateUserDto {
  @ApiProperty({
    example: 'Suspicious account activity detected or requested by customer',
    description: 'Mandatory operational justification for deactivating the account',
  })
  @IsString()
  @IsNotEmpty({ message: 'Reason for deactivation is mandatory' })
  @MinLength(5, { message: 'Reason must be at least 5 characters' })
  @MaxLength(500, { message: 'Reason must not exceed 500 characters' })
  reason!: string;
}
