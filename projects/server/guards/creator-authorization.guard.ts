import { type CanActivate, type ExecutionContext, Inject } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../common/standard-error';
import { CreatorAuthenticationService } from '../services';

/**
 * Guard that handles Creator authentication.
 * It ALLOWS anonymous requests (empty Authorization header); it is to the guarded consumer to
 * finally decide if the Creator is required or not by calling
 * {@link CreatorAuthenticationService.getAuthenticatedCreator}, which will throw a
 * {@link UnauthorizedError} if the request is not authenticated.
 */
export class CreatorAuthorizationGuard implements CanActivate {
  public static readonly authenticatedCreatorKey = Symbol(
    `${CreatorAuthorizationGuard.name}#authenticatedCreator`
  );

  @Inject(CreatorAuthenticationService)
  private readonly creatorAuthenticationService!: CreatorAuthenticationService;

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    await this.creatorAuthenticationService.authorize(request);

    return true;
  }
}
