import { IsString, IsNotEmpty, IsInt, Min, Max, Matches } from 'class-validator';

export class RequestUploadUrlDto {
  @IsString()
  @IsNotEmpty()
  fileName!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^image\/(jpeg|png|webp)$/, {
    message: 'contentType must be image/jpeg, image/png, or image/webp',
  })
  contentType!: string;

  @IsInt()
  @Min(1)
  @Max(5 * 1024 * 1024)
  fileSizeBytes!: number;
}

export class UploadDirectMediaDto {
  @IsString()
  @IsNotEmpty()
  fileName!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^image\/(jpeg|png|webp)$/, {
    message: 'contentType must be image/jpeg, image/png, or image/webp',
  })
  contentType!: string;

  @IsString()
  @IsNotEmpty()
  dataBase64!: string;
}
