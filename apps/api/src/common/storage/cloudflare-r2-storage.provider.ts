import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import type {
  StorageProvider,
  PresignedUploadUrlRequest,
  PresignedUploadUrlResponse,
  DirectUploadResponse,
} from './storage-provider.interface.js';

@Injectable()
export class CloudflareR2StorageProvider implements StorageProvider {
  readonly providerName = 'CLOUDFLARE_R2';
  private readonly logger = new Logger(CloudflareR2StorageProvider.name);

  private readonly s3Client: S3Client | null = null;
  private readonly bucketName: string | null = null;
  private readonly publicBaseUrl: string | null = null;
  private readonly configured: boolean = false;

  private cleanEnv(val: string | undefined): string | undefined {
    if (!val) return undefined;
    const trimmed = val.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      const stripped = trimmed.slice(1, -1).trim();
      return stripped.length > 0 ? stripped : undefined;
    }
    return trimmed.length > 0 ? trimmed : undefined;
  }

  constructor() {
    const accountId = this.cleanEnv(process.env['R2_ACCOUNT_ID'] || process.env['CLOUDFLARE_R2_ACCOUNT_ID']);
    const accessKeyId = this.cleanEnv(process.env['R2_ACCESS_KEY_ID'] || process.env['CLOUDFLARE_R2_ACCESS_KEY_ID']);
    const secretAccessKey = this.cleanEnv(process.env['R2_SECRET_ACCESS_KEY'] || process.env['CLOUDFLARE_R2_SECRET_ACCESS_KEY']);
    const bucketName = this.cleanEnv(process.env['R2_BUCKET_NAME'] || process.env['CLOUDFLARE_R2_BUCKET_NAME']);
    const publicUrl = this.cleanEnv(process.env['R2_PUBLIC_URL'] || process.env['CLOUDFLARE_R2_PUBLIC_URL']);

    if (accountId && accessKeyId && secretAccessKey && bucketName) {
      this.bucketName = bucketName;
      this.publicBaseUrl = publicUrl ? publicUrl.replace(/\/$/, '') : null;
      this.s3Client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
      this.configured = true;
      this.logger.log(`Cloudflare R2 storage initialized for bucket: ${bucketName}`);
    } else {
      this.logger.warn(
        'Cloudflare R2 credentials not fully set. Storage provider is running in unconfigured state.',
      );
    }
  }

  isConfigured(): boolean {
    return this.configured;
  }

  private sanitizeFileName(fileName: string): string {
    return fileName
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, '-')
      .replace(/-+/g, '-');
  }

  async getPresignedUploadUrl(
    request: PresignedUploadUrlRequest,
  ): Promise<PresignedUploadUrlResponse> {
    if (!this.s3Client || !this.bucketName) {
      throw new Error(
        'Cloudflare R2 storage is not configured. Missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or R2_BUCKET_NAME.',
      );
    }

    const folder = request.folder ? request.folder.replace(/^\/|\/$/g, '') : 'products';
    const cleanName = this.sanitizeFileName(request.fileName);
    const key = `${folder}/${Date.now()}-${randomUUID().slice(0, 8)}-${cleanName}`;
    const expiresInSeconds = 900; // 15 minutes

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: request.contentType,
      ContentLength: request.fileSizeBytes,
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: expiresInSeconds,
    });

    const publicUrl = this.publicBaseUrl
      ? `${this.publicBaseUrl}/${key}`
      : `https://${this.bucketName}.r2.cloudflarestorage.com/${key}`;

    return {
      uploadUrl,
      publicUrl,
      storageKey: key,
      expiresInSeconds,
    };
  }

  async uploadBuffer(
    buffer: Buffer,
    key: string,
    contentType: string,
  ): Promise<DirectUploadResponse> {
    if (!this.s3Client || !this.bucketName) {
      throw new Error(
        'Cloudflare R2 storage is not configured. Missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or R2_BUCKET_NAME.',
      );
    }

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ContentLength: buffer.length,
    });

    await this.s3Client.send(command);

    const publicUrl = this.publicBaseUrl
      ? `${this.publicBaseUrl}/${key}`
      : `https://${this.bucketName}.r2.cloudflarestorage.com/${key}`;

    return {
      publicUrl,
      storageKey: key,
      fileSizeBytes: buffer.length,
      contentType,
    };
  }

  async deleteFile(key: string): Promise<void> {
    if (!this.s3Client || !this.bucketName) {
      return;
    }

    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    await this.s3Client.send(command);
  }
}
