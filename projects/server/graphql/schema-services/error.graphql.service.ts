import { Inject, Injectable } from '@nestjs/common';
import SchemaBuilder from '@pothos/core';
import { StandardError } from '../../common';
import type { AppSchemaBuilder } from '../schema-builder';

@Injectable()
export class ErrorGraphQLService {
  public constructor(@Inject(SchemaBuilder) builder: AppSchemaBuilder) {
    const ErrorInterface = builder.interfaceRef<Error>('Error').implement({
      fields: t => ({
        message: t.exposeString('message')
      })
    });

    // @ts-expect-error StandardError is abstract, but that's not an issue here.
    builder.objectType(StandardError, {
      name: 'StandardError',
      interfaces: [ErrorInterface]
    });
  }
}
