import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole, UserStatus } from '@vishkaraa/types';

export class UserResponseDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  id!: string;

  @ApiProperty({ example: 'customer@example.com' })
  email!: string;

  @ApiProperty({ example: 'John' })
  firstName!: string;

  @ApiProperty({ example: 'Doe' })
  lastName!: string;

  @ApiProperty({ enum: UserRole, example: UserRole.USER })
  role!: UserRole;

  @ApiProperty({ enum: UserStatus, example: UserStatus.ACTIVE })
  status!: UserStatus;

  @ApiPropertyOptional({ example: null })
  emailVerifiedAt!: Date | null;

  @ApiProperty({ example: '2026-10-01T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-10-01T12:00:00.000Z' })
  updatedAt!: Date;
}

export class AdminUserDetailDto extends UserResponseDto {
  @ApiProperty({ example: 3, description: 'Total orders placed by this user' })
  orderCount!: number;
}

export class PaginatedUsersDto {
  @ApiProperty({ type: [UserResponseDto] })
  users!: UserResponseDto[];

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}
