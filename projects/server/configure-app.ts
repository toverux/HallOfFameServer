import path from 'node:path';
import { Logger, type LogLevel } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { config } from './config';
import * as filters from './exception-filters';
import { SentryConsoleLogger } from './logger';

/**
 * Configures the app the same way for the server and the tests, before it initializes: CORS, the
 * logger, the client build's static assets, and the global exception filters.
 */
export function configureApp(app: NestFastifyApplication): void {
  app.enableCors();

  app.useLogger(
    new SentryConsoleLogger({
      timestamp: true,
      logLevels: getLogLevels(),
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

  // We can now explicitly flush logs, if we do not do it manually now, Nest waits for application
  // startup to complete.
  Logger.flush();

  const browserDistFolder = path.resolve(import.meta.dir, '../../dist/browser');

  app.useStaticAssets({
    root: browserDistFolder
  });

  app.useGlobalFilters(
    // The catch-all error filter should actually come first to let the other more specific
    // filters take precedence.
    new filters.GlobalExceptionFilter(app.getHttpAdapter()),
    new filters.NotFoundExceptionFilter(app.getHttpAdapter())
  );
}

function getLogLevels(): LogLevel[] {
  // Only errors, so a passing test run prints nothing.
  if (config.env == 'test') {
    return ['fatal', 'error'];
  }

  return [
    'fatal',
    'error',
    'warn',
    'log',
    ...(config.env == 'development' ? (['verbose'] as const) : []),
    ...(config.verbose ? (['verbose', 'debug'] as const) : [])
  ];
}
