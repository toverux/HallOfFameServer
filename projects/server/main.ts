import './sentry';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { config, setRuntimeType } from './config';
import { configureApp } from './configure-app';
import { createFastifyAdapter } from './fastify';

setRuntimeType('server');

await linkEnvFilesForWatchMode();

await bootstrap();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter(), {
    // Buffer logs until Sentry logger is instantiated.
    bufferLogs: true
  });

  configureApp(app);

  // On SIGTERM, as a deploy sends, waits for the background tasks and releases resources.
  app.enableShutdownHooks();

  await app.listen(config.http.port, config.http.address);
}

/**
 * Link the `.env` and `.env.local` files for auto-restart in watch mode.
 * `{ with: { type: 'text' } }` is needed for Bun to not ignore the files.
 */
async function linkEnvFilesForWatchMode(): Promise<void> {
  try {
    // @ts-expect-error: TS has no type declaration for the .env text module import.
    await import('../../.env', { with: { type: 'text' } });
    // @ts-expect-error: Same.
    await import('../../.env.local', { with: { type: 'text' } });
  } catch {
    // Ignore, we're just checking if the files exist.
  }
}
