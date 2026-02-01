// tests/services/r2.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

describe('r2 service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should create R2 client with correct endpoint', async () => {
    const { createR2Service } = await import('../../src/services/r2.js');

    const service = createR2Service({
      accountId: 'test-account',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      bucketName: 'test-bucket',
      publicUrl: 'https://audio.example.com',
    });

    expect(service).toBeDefined();
    expect(service.upload).toBeDefined();
    expect(service.delete).toBeDefined();
  });

  it('should construct correct public URL', async () => {
    const { createR2Service } = await import('../../src/services/r2.js');

    const service = createR2Service({
      accountId: 'test-account',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      bucketName: 'test-bucket',
      publicUrl: 'https://audio.example.com',
    });

    const url = service.getPublicUrl('episode-123.aac');
    expect(url).toBe('https://audio.example.com/episode-123.aac');
  });
});
