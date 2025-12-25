import SchemaBuilder from '@pothos/core';
import ErrorsPlugin from '@pothos/plugin-errors';
import PrismaPlugin from '@pothos/plugin-prisma';
import PrismaUtils from '@pothos/plugin-prisma-utils';
import ScopeAuthPlugin from '@pothos/plugin-scope-auth';
import { DateTimeResolver, JSONObjectResolver } from 'graphql-scalars';
import type { PrismaClient } from '#prisma-lib/client';
import type PrismaTypes from '#prisma-lib/pothos-prisma-types';
import { getDatamodel } from '#prisma-lib/pothos-prisma-types';
import type { JsonObject } from '../../shared/utils/json';
import { ForbiddenError, StandardError } from '../common/standard-error';
import { config } from '../config';
import type { AppGraphQLContext } from './services';

export type AppSchemaBuilder = ReturnType<typeof createBuilder>;

export function createBuilder(prisma: PrismaClient) {
  const builder = new SchemaBuilder<{
    // biome-ignore-start lint/style/useNamingConvention: Pothos API's case
    DefaultFieldNullability: false;
    DefaultInputFieldRequiredness: true;
    PrismaTypes: PrismaTypes;
    Scalars: {
      JSONObject: { Input: JsonObject; Output: JsonObject };
      Date: { Input: Date; Output: Date };
    };
    Context: AppGraphQLContext;
    AuthScopes: {
      authenticatedCreator: boolean;
    };
    // biome-ignore-end lint/style/useNamingConvention: Pothos API's case
  }>({
    defaultFieldNullability: false,
    defaultInputFieldRequiredness: true,
    plugins: [ErrorsPlugin, ScopeAuthPlugin, PrismaPlugin, PrismaUtils],
    prisma: {
      client: prisma,
      dmmf: getDatamodel(),
      exposeDescriptions: true,
      filterConnectionTotalCount: true,
      // warn when not using a query parameter correctly
      onUnusedQuery: config.env == 'production' ? null : 'warn'
    },
    errors: {
      // @ts-expect-error StandardError is abstract, but that's not an issue here.
      defaultTypes: [StandardError]
    },
    scopeAuth: {
      authorizeOnSubscribe: true,
      // Use our own error type instead of the plugin's one, so we have unified error handling.
      unauthorizedError: (_parent, _context, _info, result) => new ForbiddenError(result.message),
      authScopes: context => ({
        authenticatedCreator: context.creator != null
      })
    }
  });

  builder.addScalarType('JSONObject', JSONObjectResolver);
  builder.addScalarType('Date', DateTimeResolver);

  builder.queryType({});

  return builder;
}
