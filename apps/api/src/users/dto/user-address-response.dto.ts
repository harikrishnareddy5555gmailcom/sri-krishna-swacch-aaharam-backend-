import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AddressLabel } from '@prisma/client';

export class UserAddressResponseDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  userId!: string;

  @ApiProperty({ example: 'John Doe' })
  recipientName!: string;

  @ApiProperty({ example: 'John Doe', description: 'Alias for recipientName' })
  fullName!: string;

  @ApiProperty({ example: '+919876543210' })
  phone!: string;

  @ApiProperty({ example: '42 Orchid Heights, 3rd Floor' })
  line1!: string;

  @ApiPropertyOptional({ example: 'Opposite Central Park', nullable: true })
  line2?: string | null;

  @ApiProperty({ example: 'Bengaluru' })
  city!: string;

  @ApiProperty({ example: 'Karnataka' })
  state!: string;

  @ApiProperty({ example: '560001' })
  postalCode!: string;

  @ApiProperty({ example: 'IN' })
  country!: string;

  @ApiPropertyOptional({ example: 'Near Metro Pillar 120', nullable: true })
  landmark?: string | null;

  @ApiProperty({ enum: AddressLabel, example: AddressLabel.HOME })
  label!: AddressLabel;

  @ApiProperty({ example: true })
  isDefault!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
