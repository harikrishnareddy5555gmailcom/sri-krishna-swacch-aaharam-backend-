import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageService } from '../src/common/storage/storage.service.js';
import type { StorageProvider } from '../src/common/storage/storage-provider.interface.js';
import type { AuditService } from '../src/audit/audit.service.js';
import type { MinimalUser } from '../src/permissions/permissions.service.js';
import { UserRole } from '@vishkaraa/types';

describe('StorageService (Cloudflare R2 Abstraction)', () => {
  let storageService: StorageService;
  let mockProvider: StorageProvider;
  let mockAuditService: AuditService;

  const adminUser: MinimalUser = {
    id: 'admin-uuid-1',
    role: UserRole.ADMIN,
    email: 'admin@vishkaraa.local',
  };

  beforeEach(() => {
    mockProvider = {
      providerName: 'CLOUDFLARE_R2',
      isConfigured: vi.fn().mockReturnValue(true),
      getPresignedUploadUrl: vi.fn().mockResolvedValue({
        uploadUrl: 'https://test-account.r2.cloudflarestorage.com/products/test.webp?X-Amz-Signature=test',
        publicUrl: 'https://cdn.vishkaraa.local/products/test.webp',
        storageKey: 'products/test.webp',
        expiresInSeconds: 900,
      }),
      uploadBuffer: vi.fn().mockResolvedValue({
        publicUrl: 'https://cdn.vishkaraa.local/products/direct.webp',
        storageKey: 'products/direct.webp',
        fileSizeBytes: 1024,
        contentType: 'image/webp',
      }),
      deleteFile: vi.fn().mockResolvedValue(undefined),
    };

    mockAuditService = {
      logEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;

    storageService = new StorageService(mockProvider, mockAuditService);
  });

  it('generates presigned upload URL for valid image file parameters', async () => {
    const res = await storageService.generateProductMediaUploadUrl(
      'pure-groundnut-oil.webp',
      'image/webp',
      1024 * 1024,
      adminUser,
    );

    expect(res.uploadUrl).toContain('https://test-account.r2.cloudflarestorage.com');
    expect(res.publicUrl).toBe('https://cdn.vishkaraa.local/products/test.webp');
    expect(res.storageKey).toBe('products/test.webp');
    expect(mockAuditService.logEvent).toHaveBeenCalled();
  });

  it('rejects unsupported file mime types', async () => {
    await expect(
      storageService.generateProductMediaUploadUrl(
        'script.exe',
        'application/x-msdownload',
        1024,
        adminUser,
      ),
    ).rejects.toThrow('Unsupported file type');
  });

  it('rejects files larger than 5MB', async () => {
    await expect(
      storageService.generateProductMediaUploadUrl(
        'huge-photo.jpg',
        'image/jpeg',
        6 * 1024 * 1024,
        adminUser,
      ),
    ).rejects.toThrow('exceeds maximum allowed limit');
  });

  it('fails fast with ServiceUnavailableException if provider credentials are not configured', async () => {
    vi.mocked(mockProvider.isConfigured).mockReturnValue(false);

    await expect(
      storageService.generateProductMediaUploadUrl(
        'bottle.png',
        'image/png',
        2048,
        adminUser,
      ),
    ).rejects.toThrow('Storage provider (Cloudflare R2) is not configured');
  });
});
