import {
    type ArgumentsHost,
    BadRequestException,
    Catch,
    ForbiddenException
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { StandardError } from '../common';

/**
 * Error filter that catches {@link StandardError}, which is a known error type,
 * that we can convert to a {@link BadRequestException} with the original error
 * message.
 */
@Catch(StandardError)
export class StandardErrorExceptionFilter extends BaseExceptionFilter {
    public override catch(error: StandardError, host: ArgumentsHost) {
        const ErrorConstructor =
            error.kind == 'forbidden'
                ? ForbiddenException
                : BadRequestException;

        super.catch(
            new ErrorConstructor(error.message, { cause: error }),
            host
        );
    }
}
