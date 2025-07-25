import './sentry';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { config, setRuntimeType } from './config';
import * as filters from './exception-filters';
import { fastify } from './fastify';
import { SentryConsoleLogger } from './logger';

setRuntimeType('server');

void linkEnvFilesForWatchMode();

void bootstrap();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, fastify, {
    cors: true,
    bufferLogs: true
  });

  app.useLogger(
    new SentryConsoleLogger({
      timestamp: true,
      logLevels: [
        'fatal',
        'error',
        'warn',
        'log',
        ...(config.env == 'development' ? (['verbose'] as const) : []),
        ...(config.verbose ? (['verbose', 'debug'] as const) : [])
      ],
      sentryFilterContexts: [
        'Fastify',
        'InstanceLoader',
        'NestApplication',
        'NestFactory',
        'PrismaService',
        'RouterExplorer',
        'RoutesResolver'
      ]
    })
  );

  const browserDistFolder = path.resolve(import.meta.dir, '../../dist/browser');

  app.useStaticAssets({
    root: browserDistFolder
  });

  app.useGlobalFilters(
    // The catch-all error filter should actually come first to let the other more specific
    // filters take precedence.
    new filters.GlobalExceptionFilter(app.getHttpAdapter()),
    new filters.StandardErrorExceptionFilter(app.getHttpAdapter()),
    new filters.NotFoundExceptionFilter(app.getHttpAdapter())
  );

  await app.listen(config.http.port, config.http.address);
}

/**
 * Link the `.env` and `.env.local` files for auto-restart in watch mode.
 * `{ with: { type: 'text' } }` is needed for Bun to not ignore the files.
 */
async function linkEnvFilesForWatchMode(): Promise<void> {
  try {
    // @ts-expect-error
    await import('../../.env', { with: { type: 'text' } });
    // @ts-expect-error
    await import('../../.env.local', { with: { type: 'text' } });
  } catch {
    // Ignore, we're just checking if the files exist.
  }
}
