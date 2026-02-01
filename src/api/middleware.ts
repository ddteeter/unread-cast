// src/api/middleware.ts
import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';

export function createAuthHook(apiKey: string) {
  return function authHook(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ): void {
    const providedKey = request.headers['x-api-key'];

    if (!providedKey || providedKey !== apiKey) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Missing or invalid API key',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    done();
  };
}

// List of paths that don't require auth
export const publicPaths = ['/health', '/feed/'];

export function isPublicPath(path: string): boolean {
  return publicPaths.some((p) => path.startsWith(p));
}
