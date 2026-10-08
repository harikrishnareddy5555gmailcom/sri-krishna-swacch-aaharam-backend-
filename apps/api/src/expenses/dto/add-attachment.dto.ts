import { IsNotEmpty, IsString, IsOptional, IsInt, Min, Max, Matches, IsIn } from 'class-validator';
import { IsValidMediaUrl } from '../../catalog/validators/media-url.validator.js';

export const ALLOWED_EXPENSE_ATTACHMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const MAX_EXPENSE_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export class AddExpenseAttachmentDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9_\-. ]+\.(pdf|jpg|jpeg|png|webp)$/i, {
    message:
      'fileName must be a safe filename ending in .pdf, .jpg, .jpeg, .png, or .webp without path traversal',
  })
  fileName!: string;

  @IsString()
  @IsNotEmpty()
  @IsValidMediaUrl({
    message:
      'fileUrl must be a valid URL and cannot target internal or private network addresses (anti-SSRF)',
  })
  fileUrl!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_EXPENSE_ATTACHMENT_SIZE_BYTES, {
    message: `fileSize cannot exceed 10MB (${MAX_EXPENSE_ATTACHMENT_SIZE_BYTES} bytes)`,
  })
  @IsOptional()
  fileSize?: number;

  @IsString()
  @IsIn([...ALLOWED_EXPENSE_ATTACHMENT_MIME_TYPES], {
    message:
      'mimeType must be one of: application/pdf, image/jpeg, image/png, image/webp',
  })
  @IsOptional()
  mimeType?: string;
}

