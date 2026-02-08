// tests/services/pushover.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('pushover service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should send notification when configured', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch;

    const { createPushoverService } = await import('../../src/services/pushover.js');
    const service = createPushoverService('user-key', 'app-token');

    await service.send('Test Title', 'Test message');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.pushover.net/1/messages.json',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      })
    );
  });

  it('should be a no-op when not configured', async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    const { createPushoverService } = await import('../../src/services/pushover.js');
    const service = createPushoverService(undefined, undefined);

    await service.send('Test Title', 'Test message');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should send budget warning', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch;

    const { createPushoverService } = await import('../../src/services/pushover.js');
    const service = createPushoverService('user-key', 'app-token');

    await service.sendBudgetWarning(82, 16.4, 20);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.pushover.net/1/messages.json',
      expect.objectContaining({
        method: 'POST',
      })
    );
  });
});
