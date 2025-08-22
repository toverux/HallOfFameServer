import { BadRequestException, type HttpException } from '@nestjs/common';
import type { HttpExceptionOptions } from '@nestjs/common/exceptions/http.exception';

/**
 * Base application-layer error class.
 * "Standard errors" are user or operation errors that are known and can be handled.
 *
 * They are also caught by the HTTP layer to throw a more appropriate HTTP error response than the
 * default for unknown errors, 500.
 */
export abstract class StandardError extends Error {
  /**
   * The HTTP error constructor to use when converting this error to an HTTP error, defaults to
   * {@link BadRequestException} (400).
   * Override this in subclasses to use a different error class.
   */
  public readonly httpErrorType: new (
    objectOrError?: unknown,
    descriptionOrOptions?: string | HttpExceptionOptions
  ) => HttpException = BadRequestException;
}

export class NotFoundByIdError extends StandardError {
  public readonly id: string;

  public constructor(id: string, options?: ErrorOptions) {
    super(`Could not find resource with ID "${id}".`, options);

    this.id = id;
  }
}
