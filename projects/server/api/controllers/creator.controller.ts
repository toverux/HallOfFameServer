import {
    Controller,
    Get,
    Inject,
    NotFoundException,
    Param,
    Req,
    UseGuards
} from '@nestjs/common';
import type { Creator } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { JsonObject, allFulfilled } from '../../common';
import { CreatorAuthorizationGuard } from '../../guards';
import { CreatorService, PrismaService } from '../../services';

@Controller('creators')
@UseGuards(CreatorAuthorizationGuard)
export class CreatorController {
    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    @Inject(CreatorService)
    private readonly creatorService!: CreatorService;

    /**
     * Get a Creator by ID.
     * If the ID is 'me', the authenticated Creator is returned.
     */
    @Get(':id')
    public async getCreator(
        @Req() req: FastifyRequest,
        @Param('id') creatorId: Creator['id']
    ): Promise<JsonObject> {
        const creator = await this.fetchCreatorById(creatorId, req);

        return this.creatorService.serialize(creator);
    }

    @Get(':id/stats')
    public async getCreatorStats(
        @Req() req: FastifyRequest,
        @Param('id') creatorId: Creator['id']
    ): Promise<JsonObject> {
        const creator = await this.fetchCreatorById(creatorId, req);

        const [
            allCreatorsCount,
            allScreenshotsCount,
            allViewsCount,
            screenshotsCount,
            viewsCount,
            favoritesCount
        ] = await allFulfilled([
            this.prisma.screenshot.count(),
            this.prisma.creator.count(),
            this.prisma.view.count(),
            this.prisma.screenshot.count({
                where: { creatorId: creator.id }
            }),
            this.prisma.screenshot
                .aggregate({
                    where: { creatorId: creator.id },
                    _sum: { viewsCount: true }
                })
                .then(
                    result => result._sum.viewsCount ?? 0,
                    err => {
                        throw err;
                    }
                ),
            this.prisma.screenshot
                .aggregate({
                    where: { creatorId: creator.id },
                    _sum: { favoritesCount: true }
                })
                .then(
                    result => result._sum.favoritesCount ?? 0,
                    err => {
                        throw err;
                    }
                )
        ]);

        return {
            allCreatorsCount,
            allScreenshotsCount,
            allViewsCount,
            screenshotsCount,
            viewsCount,
            favoritesCount
        };
    }

    private async fetchCreatorById(
        id: Creator['id'] | 'me',
        req: FastifyRequest
    ): Promise<Creator> {
        const creator = await this.prisma.creator.findUnique({
            where: {
                id:
                    id == 'me'
                        ? CreatorAuthorizationGuard.getAuthenticatedCreator(req)
                              .creator.id
                        : id
            }
        });

        if (!creator) {
            throw new NotFoundException(`Creator "${id}" not found.`);
        }

        return creator;
    }
}
