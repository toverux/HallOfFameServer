import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Inject
} from '@nestjs/common';
import { Creator } from '@prisma/client';
import { FastifyRequest } from 'fastify';
import { HardwareID, IPAddress } from '../common';
import { CreatorService } from '../services';

interface CreatorAuthorization {
    readonly creatorName: string;
    readonly creatorId: string;
    readonly hwid: HardwareID;
}

declare module 'fastify' {
    interface FastifyRequest {
        [CreatorAuthorizationGuard.authenticatedCreatorKey]?: Creator;
    }
}

export class CreatorAuthorizationGuard implements CanActivate {
    public static readonly authenticatedCreatorKey = Symbol(
        `${CreatorAuthorizationGuard.name}#authenticatedCreator`
    );

    @Inject()
    private readonly creatorService!: CreatorService;

    public static getAuthenticatedCreator(request: FastifyRequest): Creator {
        const creator =
            request[CreatorAuthorizationGuard.authenticatedCreatorKey];

        if (!creator) {
            throw new ForbiddenException(`Creator is not authenticated.`);
        }

        return creator;
    }

    public async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<FastifyRequest>();

        const { creatorId, creatorName, hwid } =
            this.readAuthorizationHeader(request);

        // noinspection UnnecessaryLocalVariableJS
        const creator = await this.creatorService.authenticateCreator(
            creatorId,
            creatorName,
            request.ip as IPAddress,
            hwid
        );

        request[CreatorAuthorizationGuard.authenticatedCreatorKey] = creator;

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

        return { creatorName, creatorId, hwid: hwid as HardwareID };
    }
}
