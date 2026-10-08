export interface PresignedUploadUrlRequest {
  fileName: string;
  contentType: string;
  fileSizeBytes: number;
  folder?: string;
}

export interface PresignedUploadUrlResponse {
  uploadUrl: string;
  publicUrl: string;
  storageKey: string;
  expiresInSeconds: number;
}

export interface DirectUploadResponse {
  publicUrl: string;
  storageKey: string;
  fileSizeBytes: number;
  contentType: string;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export interface StorageProvider {
  readonly providerName: string;
  isConfigured(): boolean;
  getPresignedUploadUrl(
    request: PresignedUploadUrlRequest,
  ): Promise<PresignedUploadUrlResponse>;
  uploadBuffer(
    buffer: Buffer,
    key: string,
    contentType: string,
  ): Promise<DirectUploadResponse>;
  deleteFile(key: string): Promise<void>;
}
