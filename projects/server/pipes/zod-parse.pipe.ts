import assert from 'node:assert/strict';
import { type ArgumentMetadata, BadRequestException, type PipeTransform } from '@nestjs/common';
import { oneLine } from 'common-tags';
import { ZodError, type ZodSchema } from 'zod';

export class ZodParsePipe implements PipeTransform<unknown, unknown> {
  private readonly schema: ZodSchema<unknown>;

  public constructor(schema: ZodSchema<unknown>) {
    this.schema = schema;
  }

  public transform(value: unknown, metadata: ArgumentMetadata): unknown {
    try {
      return this.schema.parse(value);
    } catch (error) {
      assert(error instanceof ZodError);

      throw new BadRequestFormatException(
        oneLine`
        Invalid ${metadata.type}
        ${metadata.data ? ` variable "${metadata.data}"` : ''}`,
        error
      );
    }
  }
}

export class BadRequestFormatException extends BadRequestException {
  public constructor(message: string, cause: ZodError) {
    super({
      ...(new BadRequestException(message).getResponse() as object),
      // delete property added by getResponse()
      error: undefined,
      validation: cause.format()
    });
  }
}
