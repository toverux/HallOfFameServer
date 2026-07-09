import assert from 'node:assert/strict';
import { Inject, Injectable } from '@nestjs/common';
import * as sentry from '@sentry/bun';
import type { FastifyRequest } from 'fastify';
import type { Creator } from '#prisma-lib/client';
import type { CreatorId, HardwareId, IpAddress } from '../../shared/utils/branded-types';
import { UnauthorizedError } from '../common/standard-error';
import { BanService } from './ban.service';
import {
  type CreatorAuthorization,
  CreatorService,
  type ModCreatorAuthorization,
  type SimpleCreatorAuthorization
} from './creator.service';

declare module 'fastify' {
  interface FastifyRequest {
    [CreatorAuthenticationService.authenticatedCreatorKey]?: Creator | undefined;
  }
}

@Injectable()
export class CreatorAuthenticationService {
  public static readonly authenticatedCreatorKey = Symbol(
    `${CreatorAuthenticationService.name}#authenticatedCreator`
  );

  @Inject(BanService)
  private readonly ban!: BanService;

  @Inject(CreatorService)
  private readonly creatorService!: CreatorService;

  /**
   * Returns the authenticated Creator from the request.
   *
   * @throws {UnauthorizedError} If the request is not authenticated.
   */
  public static getAuthenticatedCreator(request: FastifyRequest): Creator {
    const creator = request[CreatorAuthenticationService.authenticatedCreatorKey];

    if (!creator) {
      throw new UnauthorizedError(`Request not authenticated.`);
    }

    return creator;
  }

  /**
   * Authorizes the request and returns the authenticated Creator.
   * Finally, attaches the authenticated Creator to the request object
   * (see {@link CreatorAuthenticationService.getAuthenticatedCreator}).
   *
   * Throws errors if the IP creator is banned or other edge conditions.
   */
  public async authorize(request: FastifyRequest): Promise<Creator | undefined> {
    const authorization = this.getAuthorizationFromRequest(request);
    if (!authorization) {
      return undefined;
    }

    sentry.getCurrentScope().setUser({
      id: authorization.creatorId,
      username:
        authorization.kind == 'mod' && authorization.creatorName
          ? `${authorization.creatorName} (unverified)`
          : (undefined as unknown as string),
      ip_address: authorization.ip
    });

    await this.ban.ensureNotBanned(
      authorization.ip,
      authorization.kind == 'mod' ? authorization.hwid : undefined
    );

    // noinspection UnnecessaryLocalVariableJS
    const creator = await this.creatorService.authenticateCreator(authorization);

    sentry.getCurrentScope().setUser({
      id: creator.id,
      username: creator.creatorName ?? (undefined as unknown as string),
      ip_address: authorization.ip
    });

    await this.ban.ensureCreatorNotBanned(creator);

    request[CreatorAuthenticationService.authenticatedCreatorKey] = creator;

    return creator;
  }

  private getAuthorizationFromRequest(request: FastifyRequest): CreatorAuthorization | undefined {
    const header = request.headers.authorization;
    if (!header) {
      return undefined;
    }

    const ip = request.ip as IpAddress;

    try {
      const firstSpace = header.indexOf(' ');
      const scheme = header.slice(0, firstSpace);
      const payload = header.slice(firstSpace + 1);

      switch (scheme.toLowerCase()) {
        case 'creatorid': {
          return this.getSimpleAuthorizationFromRequest(ip, payload);
        }
        case 'creator': {
          return this.getModAuthorizationFromRequest(ip, payload);
        }
        default: {
          // noinspection ExceptionCaughtLocallyJS
          throw new assert.AssertionError({
            message: `Invalid Authorization scheme, expected "Creator" or "CreatorID".`
          });
        }
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) {
        throw new UnauthorizedError(`Invalid Authorization header (${error.message}).`);
      }

      throw error;
    }
  }

  private getSimpleAuthorizationFromRequest(
    ip: IpAddress,
    payload: string
  ): SimpleCreatorAuthorization {
    assert.ok(payload.length, `Creator ID must be a non-empty string.`);

    return {
      kind: 'simple',
      creatorId: payload as CreatorId,
      ip
    };
  }

  private getModAuthorizationFromRequest(ip: IpAddress, payload: string): ModCreatorAuthorization {
    const params = new URLSearchParams(payload);

    // Note: the creator name is URL-encoded, but this is already
    // decoded by URLSearchParams.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing - empty name normalizes to null
    const creatorName = params.get('name')?.trim() || null;
    const creatorId = params.get('id');
    const provider = params.get('provider');
    const hwid = params.get('hwid');

    assert.ok(
      Boolean(creatorName?.length) || creatorName === null,
      `Creator Name must be either an empty string, or a string.`
    );

    assert.ok(creatorId?.length, `Creator ID must be a non-empty string.`);

    assert.ok(
      provider == 'paradox' || provider == 'local',
      `Provider must be either "paradox" or "local".`
    );

    assert.ok(hwid?.length, `HWID must be a non-empty string.`);

    return {
      kind: 'mod',
      creatorName,
      creatorId: creatorId as CreatorId,
      creatorIdProvider: provider,
      hwid: hwid as HardwareId,
      ip
    };
  }
}
