import * as util from 'node:util';
import { ConsoleLogger, type ConsoleLoggerOptions, type LogLevel } from '@nestjs/common';
import * as sentry from '@sentry/bun';

interface AppLoggerOptions extends ConsoleLoggerOptions {
  readonly sentryFilterContexts: readonly string[];
}

export class SentryConsoleLogger extends ConsoleLogger {
  private readonly sentryFilterContexts: Set<string>;

  public constructor(options: AppLoggerOptions) {
    super(options);

    this.sentryFilterContexts = new Set(options.sentryFilterContexts);
  }

  public override debug(message: unknown, ...rest: unknown[]): void {
    this.handleLog('debug', sentry.logger.debug, message, rest);
  }

  public override verbose(message: unknown, ...rest: unknown[]): void {
    this.handleLog('verbose', sentry.logger.debug, message, rest);
  }

  public override log(message: unknown, ...rest: unknown[]): void {
    this.handleLog('log', sentry.logger.info, message, rest);
  }

  public override warn(message: unknown, ...rest: unknown[]): void {
    this.handleLog('warn', sentry.logger.warn, message, rest);
  }

  public override error(message: unknown, ...rest: unknown[]): void {
    this.handleLog('error', sentry.logger.error, message, rest);
  }

  public override fatal(message: unknown, ...rest: unknown[]): void {
    this.handleLog('fatal', sentry.logger.fatal, message, rest);
  }

  private handleLog(
    level: LogLevel,
    sentryLogFn: (msg: string, attributes: Record<string, unknown>) => void,
    message: unknown,
    rest: unknown[]
  ): void {
    super[level].call(this, message, ...rest);

    const messageStr = typeof message == 'string' ? message : util.inspect(message);

    if ((level == 'debug' || level == 'verbose') && !messageStr.includes('[sentry]')) {
      return;
    }

    const contextCandidate = rest.length > 0 ? rest.at(-1) : undefined;
    const context = typeof contextCandidate == 'string' ? contextCandidate : undefined;

    if (context && !this.sentryFilterContexts.has(context)) {
      const attributes: Record<string, unknown> = {};

      for (let i = 0; i < rest.length - 1; i++) {
        attributes[`param${i}`] = rest[i];
      }

      sentryLogFn(messageStr, attributes);
    }
  }
}
