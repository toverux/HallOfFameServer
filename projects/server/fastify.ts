import fastifyMultipart from '@fastify/multipart';
import { HttpStatus, Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config';

const httpLogger = new Logger('Fastify');

const pinoLikeLogger: FastifyBaseLogger = {
  silent: () => void 0,
  level: config.verbose ? 'trace' : 'info',
  fatal: httpLogger.fatal.bind(httpLogger),
  error: httpLogger.error.bind(httpLogger),
  warn: httpLogger.warn.bind(httpLogger),
  info: httpLogger.log.bind(httpLogger),
  debug: httpLogger.debug.bind(httpLogger),
  trace: httpLogger.debug.bind(httpLogger),
  child: () => pinoLikeLogger
};

/**
 * Creates the Fastify adapter the server and the tests build the app on, with multipart support.
 */
export function createFastifyAdapter(): FastifyAdapter {
  const adapter = new FastifyAdapter({
    trustProxy: true,
    loggerInstance: pinoLikeLogger,
    disableRequestLogging: true
  });

  // @ts-expect-error: errors due to our strict config on types we don't control.
  adapter.register(fastifyMultipart);

  return adapter;
}

@Injectable()
export class FastifyLoggerMiddleware implements NestMiddleware {
  public use(
    req: FastifyRequest & FastifyRequest['raw'],
    res: FastifyReply & FastifyReply['raw'],
    next: (error?: unknown) => void
  ): void {
    const startTime = Date.now();

    const { ip, method, originalUrl } = req;
    const reqContentLength = req.headers['content-length'] ?? 0;

    httpLogger.log(
      `[${req.id}/incoming] ${method} ${originalUrl} len=${reqContentLength} ip=${ip}`
    );

    res.on('finish', () => {
      const elapsedTime = Date.now() - startTime;

      // oxlint-disable-next-line typescript/prefer-nullish-coalescing - empty string fallthrough
      const resContentLength = String(res.getHeader('content-length') || 0);

      // oxlint-disable typescript/no-unsafe-enum-comparison - Fastify status number vs HttpStatus enum
      const logFn =
        res.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR
          ? httpLogger.error.bind(httpLogger)
          : res.statusCode >= HttpStatus.BAD_REQUEST
            ? httpLogger.warn.bind(httpLogger)
            : httpLogger.log.bind(httpLogger);
      // oxlint-enable typescript/no-unsafe-enum-comparison

      logFn(
        `[${req.id}/response] ${method} ${originalUrl} status=${res.statusCode} len=${resContentLength} ip=${ip} elapsed=${elapsedTime}ms`
      );
    });

    next();
  }
}
