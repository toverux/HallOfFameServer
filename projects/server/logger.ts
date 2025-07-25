import * as util from 'node:util';
import { ConsoleLogger, type ConsoleLoggerOptions, type LogLevel } from '@nestjs/common';
import * as sentry from '@sentry/bun';

interface AppLoggerOptions extends ConsoleLoggerOptions {
  readonly sentryFilterContexts: readonly string[];
}

export class SentryConsoleLogger extends ConsoleLogger {
  private static readonly logLevelToSentryLogFn: {
    [K in LogLevel]: (message: string, attributes: Record<string, unknown>) => void;
  } = {
    debug: sentry.logger.debug,
    verbose: sentry.logger.debug,
    log: sentry.logger.info,
    warn: sentry.logger.warn,
    error: sentry.logger.error,
    fatal: sentry.logger.fatal
  };

  private readonly sentryFilterContexts: Set<string>;

  public constructor(options: AppLoggerOptions) {
    super(options);

    this.sentryFilterContexts = new Set(options.sentryFilterContexts);
  }

  public override debug(message: unknown, ...rest: unknown[]): void {
    this.handleLog('debug', message, rest);
  }

  public override verbose(message: unknown, ...rest: unknown[]): void {
    this.handleLog('verbose', message, rest);
  }

  public override log(message: unknown, ...rest: unknown[]): void {
    this.handleLog('log', message, rest);
  }

  public override warn(message: unknown, ...rest: unknown[]): void {
    this.handleLog('warn', message, rest);
  }

  public override error(message: unknown, ...rest: unknown[]): void {
    this.handleLog('error', message, rest);
  }

  public override fatal(message: unknown, ...rest: unknown[]): void {
    this.handleLog('fatal', message, rest);
  }

  private handleLog(level: LogLevel, message: unknown, rest: unknown[]): void {
    super[level].call(this, message, ...rest);

    const contextCandidate = rest.length > 0 ? rest.at(-1) : undefined;
    const context = typeof contextCandidate == 'string' ? contextCandidate : undefined;

    if (context && !this.sentryFilterContexts.has(context)) {
      const messageStr = typeof message == 'string' ? message : util.inspect(message);

      const attributes: Record<string, unknown> = {};

      for (let i = 0; i < rest.length - 1; i++) {
        attributes[`param${i}`] = rest[i];
      }

      SentryConsoleLogger.logLevelToSentryLogFn[level](`[${context}] ${messageStr}`, attributes);
    }
  }
}
