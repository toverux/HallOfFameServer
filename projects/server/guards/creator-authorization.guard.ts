import { type CanActivate, type ExecutionContext, Inject } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Creator } from '#prisma-lib/client';
import { UnauthorizedError } from '../common/standard-error';
import { CreatorAuthenticationService } from '../services';

declare module 'fastify' {
  interface FastifyRequest {
    [CreatorAuthorizationGuard.authenticatedCreatorKey]?: Creator | undefined;
  }
}

/**
 * Guard that handles Creator authentication.
 * It ALLOWS anonymous requests (empty Authorization header), it is to the guarded consumer to
 * finally decide if the Creator is required or not by calling {@link getAuthenticatedCreator},
 * which will throw a {@link UnauthorizedError} if the request is not authenticated.
 */
export class CreatorAuthorizationGuard implements CanActivate {
  public static readonly authenticatedCreatorKey = Symbol(
    `${CreatorAuthorizationGuard.name}#authenticatedCreator`
  );

  @Inject(CreatorAuthenticationService)
  private readonly creatorAuthenticationService!: CreatorAuthenticationService;

  public static getAuthenticatedCreator(request: FastifyRequest): Creator {
    const authentication = request[CreatorAuthorizationGuard.authenticatedCreatorKey];

    if (!authentication) {
      throw new UnauthorizedError(`Request not authenticated.`);
    }

    return authentication;
  }

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    request[CreatorAuthorizationGuard.authenticatedCreatorKey] =
      await this.creatorAuthenticationService.authorize(request);

    return true;
  }
}
