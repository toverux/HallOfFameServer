import { Inject, Injectable } from '@nestjs/common';
import SchemaBuilder from '@pothos/core';
import { nn } from '../../../shared/utils';
import { PrismaService } from '../../services';
import type { AppSchemaBuilder } from '../schema-builder';

@Injectable()
export class CreatorGraphQLService {
  public constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(SchemaBuilder) builder: AppSchemaBuilder
  ) {
    builder.prismaObject('Creator', {
      fields: t => ({
        id: t.exposeID('id'),
        creatorName: t.exposeString('creatorName', { nullable: true })
      })
    });

    builder.queryType({
      fields: t => ({
        me: t.prismaField({
          type: 'Creator',
          authScopes: { authenticatedCreator: true },
          resolve(query, _parent, _args, context) {
            return prisma.creator.findFirstOrThrow({
              ...query,
              where: { id: nn(context.creator).id }
            });
          }
        })
      })
    });
  }
}
