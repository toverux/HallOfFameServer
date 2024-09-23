import assert from 'node:assert/strict';
import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Inject
} from '@nestjs/common';
import { Creator } from '@prisma/client';
import { FastifyRequest } from 'fastify';
import { CreatorID, HardwareID, IPAddress } from '../common';
import { BanService, CreatorService } from '../services';

declare module 'fastify' {
    interface FastifyRequest {
        [CreatorAuthorizationGuard.authenticatedCreatorKey]?: {
            readonly authorization: CreatorAuthorization;
            readonly creator: Creator;
        };
    }
}

export interface CreatorAuthorization {
    readonly creatorName: Creator['creatorName'];
    readonly creatorId: CreatorID;
    readonly creatorIdProvider: Creator['creatorIdProvider'];
    readonly hwid: HardwareID;
    readonly ip: IPAddress;
}

/**
 * Guard that handles Creator authentication and authorization.
 * It ALLOWS anonymous requests (empty Authorization header), it is to the
 * guarded consumer to finally decide if the Creator is required or not by
 * calling {@link getAuthenticatedCreator}, which will throw a
 * {@link ForbiddenException} if the request is not authenticated.
 */
export class CreatorAuthorizationGuard implements CanActivate {
    public static readonly authenticatedCreatorKey = Symbol(
        `${CreatorAuthorizationGuard.name}#authenticatedCreator`
    );

    @Inject()
    private readonly ban!: BanService;

    @Inject()
    private readonly creatorService!: CreatorService;

    public static getAuthenticatedCreator(request: FastifyRequest): {
        readonly authorization: CreatorAuthorization;
        readonly creator: Creator;
    } {
        const authentication =
            request[CreatorAuthorizationGuard.authenticatedCreatorKey];

        if (!authentication) {
            throw new ForbiddenException(`Creator is not authenticated.`);
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
        const creator =
            await this.creatorService.authenticateCreator(authorization);

        await this.ban.ensureCreatorNotBanned(creator);

        request[CreatorAuthorizationGuard.authenticatedCreatorKey] = {
            authorization,
            creator
        };

        return true;
    }

    private getAuthorizationFromRequest(
        request: FastifyRequest
    ): CreatorAuthorization | undefined {
        const header = request.headers.authorization;
        if (!header) {
            return undefined;
        }

        const ip = request.ip as IPAddress;

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
                creatorId: creatorId as CreatorID,
                creatorIdProvider: provider,
                hwid: hwid as HardwareID,
                ip
            };
        } catch (error) {
            // biome-ignore lint/suspicious/noMisplacedAssertion: false positive
            if (error instanceof assert.AssertionError) {
                throw new ForbiddenException(
                    `Invalid Authorization header (${error.message}).`
                );
            }

            throw error;
        }
    }
}
