import assert from 'node:assert/strict';
import { type ArgumentMetadata, BadRequestException, type PipeTransform } from '@nestjs/common';
import { oneLine } from 'common-tags';
import { ZodError, z } from 'zod';

export class ZodParsePipe implements PipeTransform<unknown, unknown> {
  private readonly schema: z.ZodType;

  public constructor(schema: z.ZodType) {
    this.schema = schema;
  }

  public transform(value: unknown, metadata: ArgumentMetadata): unknown {
    try {
      return this.schema.parse(value);
    } catch (error) {
      assert.ok(error instanceof ZodError);

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
      // Delete property added by getResponse()
      error: undefined,
      validation: z.treeifyError(cause)
    });
  }
}
