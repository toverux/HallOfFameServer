import { type ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { StandardError } from '../common';

/**
 * Error filter that catches {@link StandardError}, which is a known error type, that we can convert
 * to a NestJS HTTP error with the original error message.
 */
@Catch(StandardError)
export class StandardErrorExceptionFilter extends BaseExceptionFilter {
    public override catch(error: StandardError, host: ArgumentsHost) {
        super.catch(new error.httpErrorType(error.message, { cause: error }), host);
    }
}
