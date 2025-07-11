import assert from 'node:assert/strict';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  UnauthorizedException
} from '@nestjs/common';
import type { Creator } from '@prisma/client';
import * as sentry from '@sentry/node';
import type { FastifyRequest } from 'fastify';
import type { CreatorId, HardwareId, IpAddress } from '../common';
import { BanService, CreatorService } from '../services';

declare module 'fastify' {
  // biome-ignore lint/nursery/noShadow: intended declaration merging.
  interface FastifyRequest {
    [CreatorAuthorizationGuard.authenticatedCreatorKey]?: {
      readonly authorization: CreatorAuthorization;
      readonly creator: Creator;
    };
  }
}

export interface CreatorAuthorization {
  readonly creatorName: Creator['creatorName'];
  readonly creatorId: CreatorId;
  readonly creatorIdProvider: Creator['creatorIdProvider'];
  readonly hwid: HardwareId;
  readonly ip: IpAddress;
}

/**
 * Guard that handles Creator authentication and authorization.
 * It ALLOWS anonymous requests (empty Authorization header), it is to the guarded consumer to
 * finally decide if the Creator is required or not by calling {@link getAuthenticatedCreator},
 * which will throw a {@link UnauthorizedException} if the request is not authenticated.
 */
export class CreatorAuthorizationGuard implements CanActivate {
  public static readonly authenticatedCreatorKey = Symbol(
    `${CreatorAuthorizationGuard.name}#authenticatedCreator`
  );

  @Inject(BanService)
  private readonly ban!: BanService;

  @Inject(CreatorService)
  private readonly creatorService!: CreatorService;

  public static getAuthenticatedCreator(request: FastifyRequest): {
    readonly authorization: CreatorAuthorization;
    readonly creator: Creator;
  } {
    const authentication = request[CreatorAuthorizationGuard.authenticatedCreatorKey];

    if (!authentication) {
      throw new UnauthorizedException(`Creator is not authenticated.`);
    }

    return authentication;
  }

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    const authorization = this.getAuthorizationFromRequest(request);
    if (!authorization) {
      return true;
    }

    await this.ban.ensureNotBanned(authorization.ip, authorization.hwid);

    // noinspection UnnecessaryLocalVariableJS
    const creator = await this.creatorService.authenticateCreator(authorization);

    sentry.setUser({
      id: creator.id,
      username: creator.creatorName ?? (undefined as unknown as string),
      // biome-ignore lint/style/useNamingConvention: sentry's API
      ip_address: authorization.ip
    });

    await this.ban.ensureCreatorNotBanned(creator);

    request[CreatorAuthorizationGuard.authenticatedCreatorKey] = {
      authorization,
      creator
    };

    return true;
  }

  private getAuthorizationFromRequest(request: FastifyRequest): CreatorAuthorization | undefined {
    const header = request.headers.authorization;
    if (!header) {
      return;
    }

    const ip = request.ip as IpAddress;

    try {
      const firstSpace = header.indexOf(' ');
      const scheme = header.slice(0, firstSpace);
      const partsString = header.slice(firstSpace + 1);

      const params = new URLSearchParams(partsString);

      // Note: the creator name is URL-encoded, but this is already
      // decoded by URLSearchParams.
      const creatorName = params.get('name')?.trim() || null;
      const creatorId = params.get('id');
      const provider = params.get('provider');
      const hwid = params.get('hwid');

      assert(scheme?.toLowerCase() == 'creator', `Scheme is "Creator"`);

      assert(
        creatorName?.length || creatorName === null,
        `Creator Name must be either an empty string, or a string.`
      );

      assert(creatorId?.length, `Creator ID must be a non-empty string.`);

      assert(
        provider == 'paradox' || provider == 'local',
        `Provider must be either "paradox" or "local".`
      );

      assert(hwid?.length, `HWID must be a non-empty string.`);

      return {
        creatorName,
        creatorId: creatorId as CreatorId,
        creatorIdProvider: provider,
        hwid: hwid as HardwareId,
        ip
      };
    } catch (error) {
      // biome-ignore lint/suspicious/noMisplacedAssertion: false positive
      if (error instanceof assert.AssertionError) {
        throw new UnauthorizedException(`Invalid Authorization header (${error.message}).`);
      }

      throw error;
    }
  }
}
