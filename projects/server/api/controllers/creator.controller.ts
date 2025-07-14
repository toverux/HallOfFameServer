import {
  BadRequestException,
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
import type { Creator, CreatorSocial, Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { allFulfilled, type JsonObject } from '../../common';
import { CreatorAuthorizationGuard } from '../../guards';
import { ZodParsePipe } from '../../pipes';
import { CreatorService, PrismaService } from '../../services';

@Controller('creators')
@UseGuards(CreatorAuthorizationGuard)
export class CreatorController {
  /** @see updateMyself */
  private static readonly updateMyselfBodySchema = z
    .strictObject({
      modSettings: z.looseObject({}).optional()
    })
    .required();

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
  @UseGuards(CreatorAuthorizationGuard)
  public async updateMyself(
    @Req() req: FastifyRequest,
    @Body(new ZodParsePipe(CreatorController.updateMyselfBodySchema))
    body: z.infer<typeof CreatorController.updateMyselfBodySchema>
  ): Promise<JsonObject> {
    const { creator } = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

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

  /**
   * Redirects a request to a creator's social media page based on the provided platform.
   * Validates the platform and ensures the creator has a corresponding social link.
   * If valid, redirection occurs and the click count for that link is incremented.
   */
  @Get(':id/social/:platform')
  public async redirectCreatorSocial(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @Param('id') creatorId: Creator['id'],
    @Param('platform') platform: keyof CreatorSocial | string
  ): Promise<void> {
    const creator = await this.fetchCreatorById(creatorId, req);

    // Check the platform is supported and available for this user.
    if (!CreatorService.isValidSocialPlatform(platform)) {
      throw new BadRequestException(`Social platform "${platform}" is not supported.`);
    }

    const link = creator.social[platform];

    if (!link) {
      throw new NotFoundException(
        `Creator "${creator.creatorName}" has no social link for "${platform}".`
      );
    }

    // Make the URL and redirect asap.
    const url = CreatorService.formatSocialLink[platform]({
      // Little contraption to avoid a type error and stay strict.
      channel: '',
      code: '',
      serverName: '',
      username: '',
      ...link
    });

    res.redirect(url, HttpStatus.FOUND);

    // Increment click count for this platform.
    await this.prisma.creator.update({
      where: { id: creator.id },
      data: {
        social: {
          update: {
            [platform]: { ...link, clicks: link.clicks + 1 }
          }
        }
      }
    });
  }

  private async fetchCreatorById(id: Creator['id'] | 'me', req: FastifyRequest): Promise<Creator> {
    const creator = await this.prisma.creator.findUnique({
      where: {
        id: id == 'me' ? CreatorAuthorizationGuard.getAuthenticatedCreator(req).creator.id : id
      }
    });

    if (!creator) {
      throw new NotFoundException(`Creator "${id}" not found.`);
    }

    return creator;
  }
}
