import { Inject, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Creator } from '#prisma-lib/client';
import { CreatorAuthenticationService } from '../../services';

export interface AppGraphQLContext {
  readonly req: FastifyRequest;
  readonly reply: FastifyReply;
  readonly creator: Creator | undefined;
}

export function isAppGraphQLContext(context: unknown): context is AppGraphQLContext {
  return typeof context == 'object' && context != null && 'req' in context;
}

@Injectable()
export class GraphQLContextService {
  @Inject(CreatorAuthenticationService)
  private readonly creatorAuthenticationService!: CreatorAuthenticationService;

  public async create(req: FastifyRequest, reply: FastifyReply): Promise<AppGraphQLContext> {
    // IF there is a valid authentication scheme, always authenticate and attach the Creator to
    // context, even if it's not required by the query, for two reasons:
    // - This populates the Sentry context,
    // - Some queries use the Creator if it is present but don't necessarily require it.
    // - We check for Creator and IP bans.
    // Anonymous access is therefore granted, resolvers that require authentication need to use
    // `authScopes` from the Auth plugin.
    const creator = await this.creatorAuthenticationService.authorize(req);

    return { req, reply, creator };
  }
}
