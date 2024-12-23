import { type ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as sentry from '@sentry/bun';

/**
 * Catch-all error filter, uses the base exception filter to handle all errors that reach it, but
 * adds Sentry error reporting for all errors that are not {@link HttpException} (unless status
 * 500+) or {@link StandardError}.
 */
@Catch()
export class GlobalExceptionFilter extends BaseExceptionFilter {
    public override catch(error: unknown, host: ArgumentsHost): void {
        // Report unknown errors and 500+ errors to Sentry.
        if (!(error instanceof HttpException) || error.getStatus() >= 500) {
            sentry.captureException(error);
        }

        super.catch(error, host);
    }

    /**
     * The default implementation of this method isn't great, it's called for "unknown errors" (i.e.
     * errors that aren't {@link HttpException}) it's supposed to catch http-errors lib's errors
     * (which we don't use btw), but just checks if the error has `statusCode` and `message` props.
     *
     * In our case this was a problem with the Azure SDK errors which has `statusCode` and
     * `message`, but they're not user errors, we want to treat that as an unknown errors too
     * (resulting in a 500 error to the end user).
     *
     * So right now we don't ever want to return true for anything else as {@link HttpException} and
     * {@link StandardError} are already properly handled.
     */
    public override isHttpError(
        _error: unknown
    ): _error is { statusCode: number; message: string } {
        return false;
    }
}
