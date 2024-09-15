import assert from 'node:assert/strict';
import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Inject
} from '@nestjs/common';
import { Creator } from '@prisma/client';
import { FastifyRequest } from 'fastify';
import { CreatorID, HardwareID } from '../common';
import { BanService, CreatorService } from '../services';

export interface CreatorAuthorization {
    readonly creatorName: string | null;
    readonly creatorId: CreatorID;
    readonly hwid: HardwareID;
}

declare module 'fastify' {
    interface FastifyRequest {
        [CreatorAuthorizationGuard.authenticatedCreatorKey]?: {
            readonly authorization: CreatorAuthorization;
            readonly creator: Creator;
        };
    }
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

        const authorization = this.readAuthorizationHeader(request);
        if (!authorization) {
            return true;
        }

        // noinspection UnnecessaryLocalVariableJS
        const creator = await this.creatorService.authenticateCreator(
            authorization.creatorId,
            authorization.creatorName,
            authorization.hwid
        );

        await this.ban.ensureNotBanned(authorization.hwid, creator.id);

        request[CreatorAuthorizationGuard.authenticatedCreatorKey] = {
            authorization,
            creator
        };

        return true;
    }

    private readAuthorizationHeader(
        request: FastifyRequest
    ): CreatorAuthorization | undefined {
        const header = request.headers.authorization;
        if (!header) {
            return undefined;
        }

        try {
            const firstSpace = header.indexOf(' ');
            const scheme = header.slice(0, firstSpace);
            const partsString = header.slice(firstSpace + 1);

            const parts = partsString?.split(';');

            assert(parts?.length == 3);

            const creatorName = parts[0]?.trim() || null;
            const creatorId = parts[1]?.trim();
            const hwid = parts[2]?.trim();

            assert(scheme?.toLowerCase() == 'creator', `Scheme is "Creator"`);

            assert(
                creatorName?.length || creatorName === null,
                `Creator Name must be either an empty string, or a string.`
            );

            assert(creatorId?.length, `Creator ID must be a non-empty string.`);

            assert(hwid?.length, `HWID must be a non-empty string.`);

            return {
                creatorName,
                creatorId: creatorId as CreatorID,
                hwid: hwid as HardwareID
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
