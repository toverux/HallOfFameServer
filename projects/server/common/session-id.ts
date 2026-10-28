import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

export const sessionIdSchema = z.uuid();

/**
 * Returns the session ID of a mod request, the random UUID the mod draws once per game launch and
 * sends as the `X-Session-Id` header while the player allows usage statistics.
 * Older mod versions send none, so a missing or malformed header yields `undefined` and never fails
 * the request.
 */
export function getSessionId(request: FastifyRequest): string | undefined {
  const result = sessionIdSchema.safeParse(request.headers['x-session-id']);

  return result.success ? result.data : undefined;
}
