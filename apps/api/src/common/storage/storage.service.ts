import {
  Injectable,
  Inject,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
  type PresignedUploadUrlResponse,
  type DirectUploadResponse,
} from './storage-provider.interface.js';
import type { MinimalUser } from '../../permissions/permissions.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction, AuditEntityType } from '@vishkaraa/types';

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    private readonly auditService: AuditService,
  ) {}

  isConfigured(): boolean {
    return this.storageProvider.isConfigured();
  }

  getProviderName(): string {
    return this.storageProvider.providerName;
  }

  async generateProductMediaUploadUrl(
    fileName: string,
    contentType: string,
    fileSizeBytes: number,
    user: MinimalUser,
  ): Promise<PresignedUploadUrlResponse> {
    if (!this.storageProvider.isConfigured()) {
      throw new ServiceUnavailableException({
        code: 'STORAGE_NOT_CONFIGURED',
        message:
          'Storage provider (Cloudflare R2) is not configured with required environment credentials.',
        requiredEnvVars: [
          'R2_ACCOUNT_ID',
          'R2_ACCESS_KEY_ID',
          'R2_SECRET_ACCESS_KEY',
          'R2_BUCKET_NAME',
          'R2_PUBLIC_URL',
        ],
      });
    }

    if (!ALLOWED_MIME_TYPES.includes(contentType)) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: `Unsupported file type: ${contentType}. Permitted types: ${ALLOWED_MIME_TYPES.join(', ')}`,
      });
    }

    if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException({
        code: 'PAYLOAD_TOO_LARGE',
        message: `File size ${fileSizeBytes} bytes exceeds maximum allowed limit of ${MAX_FILE_SIZE_BYTES} bytes (5 MB).`,
      });
    }

    const res = await this.storageProvider.getPresignedUploadUrl({
      fileName,
      contentType,
      fileSizeBytes,
      folder: 'products',
    });

    await this.auditService.logEvent({
      actorId: user.id,
      actorRole: user.role,
      actorEmail: user.email,
      action: AuditAction.MEDIA_ADDED,
      entityType: AuditEntityType.PRODUCT,
      entityId: res.storageKey,
      metadata: {
        fileName,
        contentType,
        fileSizeBytes,
        storageKey: res.storageKey,
        provider: this.storageProvider.providerName,
      },
    });

    return res;
  }

  async uploadProductMediaDirect(
    fileBuffer: Buffer,
    fileName: string,
    contentType: string,
    user: MinimalUser,
  ): Promise<DirectUploadResponse> {
    if (!this.storageProvider.isConfigured()) {
      throw new ServiceUnavailableException({
        code: 'STORAGE_NOT_CONFIGURED',
        message:
          'Storage provider (Cloudflare R2) is not configured with required environment credentials.',
      });
    }

    if (!ALLOWED_MIME_TYPES.includes(contentType)) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: `Unsupported file type: ${contentType}. Permitted types: ${ALLOWED_MIME_TYPES.join(', ')}`,
      });
    }

    if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException({
        code: 'PAYLOAD_TOO_LARGE',
        message: `File size ${fileBuffer.length} bytes exceeds maximum allowed limit of ${MAX_FILE_SIZE_BYTES} bytes.`,
      });
    }

    const key = `products/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const res = await this.storageProvider.uploadBuffer(fileBuffer, key, contentType);

    await this.auditService.logEvent({
      actorId: user.id,
      actorRole: user.role,
      actorEmail: user.email,
      action: AuditAction.MEDIA_ADDED,
      entityType: AuditEntityType.PRODUCT,
      entityId: res.storageKey,
      metadata: {
        fileName,
        contentType,
        fileSizeBytes: res.fileSizeBytes,
        storageKey: res.storageKey,
      },
    });

    return res;
  }

  extractStorageKey(keyOrUrl: string): string | null {
    if (!keyOrUrl || typeof keyOrUrl !== 'string') return null;
    const trimmed = keyOrUrl.trim();
    if (!trimmed) return null;
    // Strip domain if full URL passed (e.g. https://pub-xxx.r2.dev/products/123-abc.jpg)
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const match = trimmed.replace(/^https?:\/\/[^\/]+\//, '');
      return match ? decodeURIComponent(match) : null;
    }
    return trimmed;
  }

  async deleteFile(keyOrUrl: string, user?: MinimalUser): Promise<void> {
    const key = this.extractStorageKey(keyOrUrl);
    if (!key) return;

    if (!this.storageProvider.isConfigured()) {
      this.logger.warn(`Storage provider not configured, skipping permanent delete of: ${key}`);
      return;
    }

    try {
      await this.storageProvider.deleteFile(key);
      this.logger.log(`[Storage] Permanently deleted object from R2: ${key}`);

      if (user) {
        await this.auditService.logEvent({
          actorId: user.id,
          actorRole: user.role,
          actorEmail: user.email,
          action: AuditAction.MEDIA_REMOVED,
          entityType: AuditEntityType.PRODUCT,
          entityId: key,
          metadata: { storageKey: key },
        });
      }
    } catch (err: unknown) {
      this.logger.error(`[Storage] Failed to delete object ${key} from R2: ${(err as Error).message}`);
    }
  }
}
