// tests/api/middleware.test.ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';

describe('auth middleware', () => {
  it('should reject requests without API key', async () => {
    const { createAuthHook } = await import('../../src/api/middleware.js');

    const app = Fastify();
    app.addHook('preHandler', createAuthHook('test-api-key'));
    app.get('/test', () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/test',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should reject requests with wrong API key', async () => {
    const { createAuthHook } = await import('../../src/api/middleware.js');

    const app = Fastify();
    app.addHook('preHandler', createAuthHook('test-api-key'));
    app.get('/test', () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'X-API-Key': 'wrong-key' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('should allow requests with correct API key', async () => {
    const { createAuthHook } = await import('../../src/api/middleware.js');

    const app = Fastify();
    app.addHook('preHandler', createAuthHook('test-api-key'));
    app.get('/test', () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'X-API-Key': 'test-api-key' },
    });

    expect(response.statusCode).toBe(200);
  });
});
