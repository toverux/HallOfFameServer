/**
 * Bun test preload for the live tests, which call real external APIs with the developer's
 * credentials, loaded by mise from `.env.local`.
 */

import { setDefaultTimeout } from 'bun:test';
import process from 'node:process';

// Reasoning takes tens of seconds, far past bun's five-second default.
// Set here: bun 1.3.14 ignores a `timeout` under `[test]` in bunfig.
const timeoutMs = 120_000;

setDefaultTimeout(timeoutMs);

// The committed `.env` holds a placeholder, which would fail every call on authentication.
if (!process.env.HOF_OPENAI_API_KEY?.startsWith('sk-')) {
  throw new Error(`The live tests need a real HOF_OPENAI_API_KEY, set it in .env.local.`);
}
