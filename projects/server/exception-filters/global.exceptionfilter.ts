import { type ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as sentry from '@sentry/bun';
import type { FastifyRequest } from 'fastify';
import { StandardError } from '../common';
import { config } from '../config';

/**
 * Catch-all error filter, uses the base exception filter to handle all errors that reach it, but
 * adds Sentry error reporting for all errors that are not {@link HttpException} (unless status
 * 500+) or {@link StandardError}.
 */
@Catch()
export class GlobalExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  public override catch(error: unknown, host: ArgumentsHost): void {
    const responseError =
      error instanceof StandardError
        ? new error.httpErrorType(error.message, {
            cause: error,
            description: error.constructor.name
          })
        : error;

    const reqId = host.switchToHttp().getRequest<FastifyRequest>().id;

    // Report unknown errors and 500+ errors to Sentry, log the rest as warnings.
    if (!(responseError instanceof HttpException) || responseError.getStatus() >= 500) {
      // We do not need to call this.logger.error() as it's already handled by super.catch().
      sentry.captureException(error, { extra: { reqId } });
    } else {
      this.logger.warn(
        `[${reqId}/error] ${responseError.name}/${responseError.getStatus()}: ${(error as object).constructor.name}: ${responseError.message}`
      );

      if (config.verbose) {
        this.logger.warn(error);
      }
    }

    super.catch(responseError, host);
  }

  /**
   * The default implementation of this method isn't great, it's called for "unknown errors" (i.e.,
   * errors that aren't {@link HttpException}) it's supposed to catch http-errors' lib errors
   * (which we don't use btw), but just checks if the error has `statusCode` and `message` props.
   *
   * In our case this was a problem with the Azure SDK errors which have `statusCode` and
   * `message`. However, they're not user errors; we want to treat these as unknown errors too
   * (resulting in a 500 error to the end user).
   *
   * So right now we don't ever want to return true for anything else as {@link HttpException} and
   * {@link StandardError} are already properly handled.
   */
  public override isHttpError(_error: unknown): _error is { statusCode: number; message: string } {
    return false;
  }
}
