/**
 * Bun test preload overwriting the environment before any server module reads its configuration,
 * so tests see the checked-in defaults plus test values, whatever `.env.local` or the shell set,
 * and never reach real credentials or a developer's database.
 * Keep it free of imports that read the configuration.
 */

import path from 'node:path';
import process from 'node:process';
import { parseEnv } from 'node:util';
import * as Bun from 'bun';

// Unique per run, so concurrent runs never share a database.
const databaseName = `halloffame-test-${Date.now()}-${process.pid}`;

Object.assign(
  process.env,
  parseEnv(await Bun.file(path.join(import.meta.dir, '../../../.env')).text()),
  {
    // The test runner sets NODE_ENV only when unset, and `.env` sets development.
    NODE_ENV: 'test',
    HOF_DATABASE_URL: `mongodb://localhost/${databaseName}`,
    // Well-formed values that lead nowhere: a closed loopback port and a reserved TLD.
    HOF_AZURE_URL:
      'DefaultEndpointsProtocol=http;AccountName=inert;AccountKey=aW5lcnQ=;BlobEndpoint=http://127.0.0.1:1/inert;',
    HOF_AZURE_CDN: 'https://cdn.halloffame.invalid',
    HOF_OPENAI_API_KEY: 'sk-inert',
    HOF_SKYVE_API_KEY: 'skyve-inert',
    HOF_SENTRY_DSN: 'disabled'
  }
);
