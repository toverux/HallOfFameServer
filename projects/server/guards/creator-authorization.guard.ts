import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Inject
} from '@nestjs/common';
import { Creator } from '@prisma/client';
import { FastifyRequest } from 'fastify';
import { CreatorID, HardwareID, IPAddress } from '../common';
import { CreatorService } from '../services';

export interface CreatorAuthorization {
    readonly creatorName: string;
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

export class CreatorAuthorizationGuard implements CanActivate {
    public static readonly authenticatedCreatorKey = Symbol(
        `${CreatorAuthorizationGuard.name}#authenticatedCreator`
    );

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

        // noinspection UnnecessaryLocalVariableJS
        const creator = await this.creatorService.authenticateCreator(
            authorization.creatorId,
            authorization.creatorName,
            request.ip as IPAddress,
            authorization.hwid
        );

        request[CreatorAuthorizationGuard.authenticatedCreatorKey] = {
            authorization,
            creator
        };

        return true;
    }

    private readAuthorizationHeader(
        request: FastifyRequest
    ): CreatorAuthorization {
        const header = request.headers.authorization;
        if (!header) {
            throw new ForbiddenException(`Authorization header is missing.`);
        }

        const [scheme, partsString] = header.split(' ');

        const parts = partsString?.split(';');

        if (scheme?.toLowerCase() != 'creator' || parts?.length != 3) {
            throw new ForbiddenException(`Invalid Authorization header.`);
        }

        const [creatorName, creatorId, hwid] = parts as [
            string,
            string,
            string
        ];

        return {
            creatorName,
            creatorId: creatorId as CreatorID,
            hwid: hwid as HardwareID
        };
    }
}
