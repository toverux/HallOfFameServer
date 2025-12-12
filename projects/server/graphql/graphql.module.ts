import { YogaDriver } from '@graphql-yoga/nestjs';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql/dist/graphql.module';
import SchemaBuilder from '@pothos/core';
import { PrismaService } from '../services';
import { type AppSchemaBuilder, createBuilder } from './schema-builder';
import { schemaServices } from './schema-services';
import { GraphQLContextService, services } from './services';
import { yogaBuilder } from './yoga-builder';

@Module({
  providers: [
    ...services,
    ...schemaServices,
    {
      provide: SchemaBuilder,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => createBuilder(prisma)
    }
  ],
  exports: [...services, ...schemaServices, SchemaBuilder]
})
// biome-ignore lint/complexity/noStaticOnlyClass: common NestJS pattern.
export class GraphQLModule {
  public static forRoot(): DynamicModule {
    return {
      global: true,
      module: GraphQLModule,
      imports: [
        NestGraphQLModule.forRootAsync({
          driver: YogaDriver,
          imports: [GraphQLModule],
          inject: [
            SchemaBuilder,
            GraphQLContextService,
            // Inject all schema services to ensure they're eagerly instantiated before the schema
            // is built.
            ...schemaServices
          ],
          useFactory(builder: AppSchemaBuilder, contextService: GraphQLContextService) {
            return yogaBuilder(builder, contextService, new Logger('GraphQL'));
          }
        })
      ]
    };
  }
}
