import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Put,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Creator, Prisma } from '#prisma-lib/client';
import { allFulfilled } from '../../../shared/utils/all-fulfilled';
import type { JsonObject } from '../../../shared/utils/json';
import { NotFoundByIdError } from '../../common/standard-error';
import { CreatorAuthorizationGuard } from '../../guards';
import { ZodParsePipe } from '../../pipes';
import { CreatorService, PrismaService } from '../../services';

@Controller('creators')
@UseGuards(CreatorAuthorizationGuard)
export class CreatorController {
  /** @see updateMyself */
  private static readonly updateMyselfBodySchema = z.strictObject({
    modSettings: z.looseObject({}).optional()
  });

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

  /**
   * Update the authenticated Creator.
   * Allowed fields:
   *  - `modSettings`: a raw JSON object with arbitrary keys and values of the current mod
   *    settings.
   */
  @Put('me')
  public async updateMyself(
    @Req() req: FastifyRequest,
    @Body(new ZodParsePipe(CreatorController.updateMyselfBodySchema))
    body: z.infer<typeof CreatorController.updateMyselfBodySchema>
  ): Promise<JsonObject> {
    const creator = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

    const updated = await this.prisma.creator.update({
      where: { id: creator.id },
      data: {
        modSettings: body.modSettings as Prisma.InputJsonObject
      }
    });

    return this.creatorService.serialize(updated);
  }

  @Get(':id/stats')
  public async getCreatorStats(
    @Req() req: FastifyRequest,
    @Param('id') creatorId: Creator['id']
  ): Promise<JsonObject> {
    const creator = await this.fetchCreatorById(creatorId, req);

    const [
      allScreenshotsCount,
      allCreatorsCount,
      allViewsCount,
      screenshotsCount,
      { viewsCount, uniqueViewsCount, favoritesCount }
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
          _sum: { viewsCount: true, uniqueViewsCount: true, favoritesCount: true }
        })
        .then(({ _sum: sum }) => ({
          viewsCount: sum.viewsCount ?? 0,
          uniqueViewsCount: sum.uniqueViewsCount ?? 0,
          favoritesCount: sum.favoritesCount ?? 0
        }))
        .catch(err => {
          throw err;
        })
    ]);

    return {
      allCreatorsCount,
      allScreenshotsCount,
      allViewsCount,
      screenshotsCount,
      viewsCount,
      uniqueViewsCount,
      favoritesCount
    };
  }

  /**
   * Redirects a request to a creator's social media page based on the provided platform.
   * Ensures the creator has a corresponding social link and redirects to it.
   * The click count for that link is incremented.
   */
  @Get(':id/social/:platform')
  public async redirectCreatorSocial(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @Param('id') creatorId: Creator['id'],
    @Param('platform') platformName: string
  ): Promise<void> {
    const creator = await this.fetchCreatorById(creatorId, req);

    const platform = creator.socials.find(social => social.platform == platformName);

    if (!platform) {
      throw new NotFoundException(
        `Creator "${creator.creatorName}" has no social link for "${platformName}".`
      );
    }

    // Redirect to the direct link stored in the database.
    res.redirect(platform.link, HttpStatus.TEMPORARY_REDIRECT);

    // Increment click count for this platform.
    platform.clicks++;

    await this.prisma.creator.update({
      where: { id: creator.id },
      data: { socials: creator.socials }
    });
  }

  private async fetchCreatorById(id: Creator['id'] | 'me', req: FastifyRequest): Promise<Creator> {
    const creator = await this.prisma.creator.findUnique({
      where: {
        id: id == 'me' ? CreatorAuthorizationGuard.getAuthenticatedCreator(req).id : id
      }
    });

    if (!creator) {
      throw new NotFoundByIdError(id);
    }

    return creator;
  }
}
