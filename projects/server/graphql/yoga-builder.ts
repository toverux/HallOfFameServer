import type { YogaDriverConfig } from '@graphql-yoga/nestjs';
import type { Logger } from '@nestjs/common';
import * as sentry from '@sentry/bun';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type ASTNode, GraphQLError, print } from 'graphql';
import * as yoga from 'graphql-yoga';
import * as textCase from 'text-case';
import { StandardError } from '../common/standard-error';
import { config } from '../config';
import type { AppSchemaBuilder } from './schema-builder';
import {
  type AppGraphQLContext,
  type GraphQLContextService,
  isAppGraphQLContext
} from './services';

export function yogaBuilder(
  builder: AppSchemaBuilder,
  contextService: GraphQLContextService,
  logger: Logger
): YogaDriverConfig<'fastify'> {
  return {
    schema: builder.toSchema(),
    debug: config.env == 'development',
    batching: true,
    maskedErrors: {
      isDev: config.env == 'development',
      maskError
    },
    context({ req, reply }: { req: FastifyRequest; reply: FastifyReply }) {
      return contextService.create(req, reply);
    },
    plugins: [yoga.useErrorHandler<AppGraphQLContext>(handleErrors.bind(null, logger))]
  };
}

/**
 * Custom Yoga error masker to transform {@link StandardError} into "not unexpected"
 * {@link GraphQLError}, as a {@link StandardError} are always exposable.
 * The default behavior would be a masked GraphQLError with an "Unexpected error" message and
 * `INTERNAL_SERVER_ERROR` code.
 */
function maskError(error: unknown, message: string, isDev = false): GraphQLError {
  const originalError = error instanceof GraphQLError ? error.originalError : undefined;

  // If the error is a pre-masking GraphQLError and the cause is a StandardError, we can expose the
  // StandardError contents.
  if (error instanceof GraphQLError && originalError instanceof StandardError) {
    const newError = yoga.maskError(originalError, message, isDev) as GraphQLError;

    newError.message = originalError.message;

    Object.assign(newError.extensions, {
      code: textCase.constantCase(originalError.constructor.name)
    });

    return newError;
  }

  // If the error is not a StandardError, use standard Yoga masking.
  // (type cast: in practice, it will always return a GraphQLError.)
  return yoga.maskError(error, message, isDev) as GraphQLError;
}

/**
 * Handles errors happening during GraphQL execution.
 * This function should in theory always receive a {@link GraphQLError} (ex. other errors in
 * resolvers are already wrapper before being passed to this function), but the framework does
 * require us to be able to handle other errors as well.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: splitting it would make it harder to follow.
function handleErrors(
  logger: Logger,
  { errors, context }: { errors: readonly unknown[]; context: Readonly<Record<string, unknown>> }
): void {
  // We will iterate each error to log them.
  for (const error of errors) {
    // Extract request ID from Fastify if available.
    const reqId = isAppGraphQLContext(context.contextValue)
      ? context.contextValue.req.id
      : 'unknown';

    // Extract the cause error if we received a GraphQLError.
    const originalError = error instanceof GraphQLError ? error.originalError : undefined;

    // This is a GraphQLError that originates from the engine/framework, ex. query validation
    // errors, we can ignore those.
    if (error instanceof GraphQLError && !error.originalError) {
      logger.warn(`[${reqId}/error] ${error.name}: ${error.message}`);
    }
    // If the error is a StandardError, it's not unexpected, log it as a warning for debug and
    // monitoring only.
    else if (error instanceof GraphQLError && originalError instanceof StandardError) {
      logger.warn(`[${reqId}/error] ${originalError.constructor.name}: ${originalError.message}`);

      // Log stack trace only in verbose mode.
      if (config.verbose) {
        logger.warn(error);
      }
    }
    // If it's any other kind of error, log it as an error and report it to Sentry.
    else {
      logger.error(originalError);

      sentry.captureException(originalError, {
        extra: {
          reqId,
          operationName: context.operationName,
          document: context.document ? print(context.document as ASTNode) : undefined,
          variableValues: context.variableValues
        }
      });
    }
  }
}
