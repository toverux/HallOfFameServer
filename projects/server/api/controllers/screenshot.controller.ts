import assert from 'node:assert/strict';
import type { Multipart } from '@fastify/multipart';
import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { oneLine } from 'common-tags';
import type { FastifyRequest } from 'fastify';
import { type JsonObject, type ParadoxModId, StandardError } from '../../common';
import { isPrismaError } from '../../common/prisma-errors';
import { config } from '../../config';
import { CreatorAuthorizationGuard } from '../../guards';
import { FavoriteService, PrismaService, ScreenshotService, ViewService } from '../../services';

@Controller('screenshots')
@UseGuards(CreatorAuthorizationGuard)
export class ScreenshotController {
  /**
   * Regular expression to validate a city name:
   * - Must contain only letters, numbers, spaces, hyphens, apostrophes and commas (Latin, CJK) and
   *   Chinese middle dot.
   * - Must be between 1 and 35 characters long. 1-character-long names are for languages like
   *   Chinese.
   */
  private static readonly cityNameRegex = /^[\p{L}\p{N}\- '’,、•]{1,35}$/u;

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(FavoriteService)
  private readonly favoriteService!: FavoriteService;

  @Inject(ScreenshotService)
  private readonly screenshotService!: ScreenshotService;

  @Inject(ViewService)
  private readonly viewService!: ViewService;

  /**
   * Retrieves all screenshots optionally filtered by a specific creator ID.
   * Provides additional metadata such as favorited status if the user is authenticated.
   */
  @Get()
  public async getAll(
    @Req() req: FastifyRequest,
    @Query('creatorId') creatorId: string | undefined,
    @Query('favorites', new ParseBoolPipe({ optional: true })) includeFavorites = false,
    @Query('views', new ParseBoolPipe({ optional: true })) includeViews = false
  ): Promise<JsonObject[]> {
    if (!creatorId && (includeFavorites || includeViews)) {
      throw new BadRequestException(
        `The 'favorites' and 'views' query parameters are only supported when filtering by creator ID.`
      );
    }

    const authed = req[CreatorAuthorizationGuard.authenticatedCreatorKey];

    // If the creatorId filter is 'me', replace it with the logged-in creator ID.
    if (creatorId == 'me') {
      // biome-ignore lint/style/noParameterAssign: legitimate case
      creatorId = CreatorAuthorizationGuard.getAuthenticatedCreator(req).creator.id;
    }

    const screenshots = await this.prisma.screenshot.findMany({
      where: { creatorId: creatorId ?? Prisma.skip },
      include: {
        creator: true,
        favorites: includeFavorites ? { include: { creator: true } } : Prisma.skip,
        views: includeViews ? { include: { creator: true } } : Prisma.skip
      }
    });

    // If the user is authenticated, we check whether each screenshot has been favorited.
    const favorited =
      authed &&
      (await this.favoriteService.isFavoriteBatched(
        screenshots.map(s => s.id),
        authed.creator.id,
        authed.authorization.ip,
        authed.authorization.hwid
      ));

    return screenshots.map((screenshot, index) => {
      const payload = this.screenshotService.serialize(screenshot, req);

      payload.__favorited = favorited?.[index] ?? false;

      return payload;
    });
  }

  /**
   * Returns a single screenshot by its ID.
   * Provides additional metadata such as favorited status if the user is authenticated.
   */
  @Get(':id')
  public async getOne(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Query('favorites', new ParseBoolPipe({ optional: true })) includeFavorites = false,
    @Query('views', new ParseBoolPipe({ optional: true })) includeViews = false
  ): Promise<JsonObject> {
    const authed = req[CreatorAuthorizationGuard.authenticatedCreatorKey];

    const screenshot = await this.prisma.screenshot.findUnique({
      where: { id },
      include: {
        creator: true,
        favorites: includeFavorites ? { include: { creator: true } } : Prisma.skip,
        views: includeViews ? { include: { creator: true } } : Prisma.skip
      }
    });

    if (!screenshot) {
      throw new NotFoundException(`Could not find Screenshot #${id}.`);
    }

    const payload = this.screenshotService.serialize(screenshot, req);

    // If the user is authenticated, we check if the screenshot is already in their favorites.
    // Otherwise, just set it to false.
    payload.__favorited =
      authed != null &&
      (await this.favoriteService.isFavorite(
        screenshot.id,
        authed.creator.id,
        authed.authorization.ip,
        authed.authorization.hwid
      ));

    return payload;
  }

  /**
   * Returns a random screenshot.
   * Different algorithms can be used to select the screenshot randomly, to each algorithm a
   * weight can be assigned to favor one method over others.
   * See {@link ScreenshotService} for the description of the algorithms.
   * By default, all weights are zero and "random" is used.
   *
   * @param req           The request object.
   * @param random        Weight for the "random" algorithm, see
   *                      {@link ScreenshotService.getScreenshotRandom}.
   * @param trending      Weight for the "trending" algorithm, see
   *                      {@link ScreenshotService.getScreenshotTrending}.
   * @param recent        Weight for the "recent" algorithm, see
   *                      {@link ScreenshotService.getScreenshotRecent}.
   * @param archeologist  Weight for the "archeologist" algorithm, see
   *                      {@link ScreenshotService.getScreenshotArcheologist}.
   * @param supporter     Weight for the "supporter" algorithm, see
   *                      {@link ScreenshotService.getScreenshotSupporter}.
   * @param viewMaxAge    Min time in days before showing a screenshot the user has already seen.
   *                      Default is 60, 0 is no limit.
   */
  @Get('weighted')
  public async getRandomWeighted(
    @Req()
    req: FastifyRequest,
    @Query('random', new ParseIntPipe({ optional: true }))
    random = 0,
    @Query('trending', new ParseIntPipe({ optional: true }))
    trending = 0,
    @Query('recent', new ParseIntPipe({ optional: true }))
    recent = 0,
    @Query('archeologist', new ParseIntPipe({ optional: true }))
    archeologist = 0,
    @Query('supporter', new ParseIntPipe({ optional: true }))
    supporter = 0,
    @Query('viewMaxAge', new ParseIntPipe({ optional: true }))
    viewMaxAge = 60
  ) {
    const authed = req[CreatorAuthorizationGuard.authenticatedCreatorKey];

    const weights = { random, trending, recent, archeologist, supporter };

    const screenshot = await this.screenshotService.getWeightedRandomScreenshot(
      weights,
      authed?.creator.id,
      viewMaxAge
    );

    const createdBy = await this.prisma.creator.findFirst({
      where: { id: screenshot.creatorId }
    });

    assert(createdBy, `Could not find Creator #${screenshot.creatorId}`);

    const payload = this.screenshotService.serialize(
      {
        ...screenshot,
        creator: createdBy
      },
      req
    );

    payload.__algorithm = screenshot.__algorithm;

    // If the user is authenticated, we check if the screenshot is already in their favorites.
    // Otherwise, just set it to false.
    payload.__favorited =
      authed != null &&
      (await this.favoriteService.isFavorite(
        screenshot.id,
        authed.creator.id,
        authed.authorization.ip,
        authed.authorization.hwid
      ));

    return payload;
  }

  /**
   * Delete a screenshot by ID.
   *
   * @throws NotFoundException if the screenshot cannot be found.
   * @throws ForbiddenException if the authenticated creator is not the one who posted the
   *                            screenshot.
   */
  @Delete(':id')
  public async deleteOne(@Req() req: FastifyRequest, @Param('id') id: string): Promise<JsonObject> {
    const authed = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

    const screenshot = await this.prisma.screenshot.findUnique({
      where: { id },
      select: { creatorId: true }
    });

    if (!screenshot) {
      throw new NotFoundException(`Could not find Screenshot #${id}.`);
    }

    if (screenshot.creatorId != authed.creator.id) {
      throw new ForbiddenException(`You cannot delete screenshots that are not yours.`);
    }

    const deletedScreenshot = await this.screenshotService.deleteScreenshot(id);

    return this.screenshotService.serialize(deletedScreenshot, req);
  }

  /**
   * Adds the screenshot to the authenticated creator's favorites.
   * We also verify that the screenshot was not already favorites using a same IP or HWID, as
   * multi-accounting on favorites is not allowed.
   */
  @Post(':id/favorites')
  public async addToFavorites(
    @Req() req: FastifyRequest,
    @Param('id') screenshotId: string
  ): Promise<JsonObject> {
    const authed = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

    const favorite = await this.favoriteService.addFavorite(
      screenshotId,
      authed.creator.id,
      authed.authorization.ip,
      authed.authorization.hwid
    );

    return this.favoriteService.serialize(favorite);
  }

  /**
   * Deletes the screenshot from the authenticated creator's favorites.
   */
  @Delete(':id/favorites/mine')
  public async removeFromFavorites(
    @Req() req: FastifyRequest,
    @Param('id') screenshotId: string
  ): Promise<JsonObject> {
    const authed = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

    const favorite = await this.favoriteService.removeFavorite(
      screenshotId,
      authed.creator.id,
      authed.authorization.ip,
      authed.authorization.hwid
    );

    return this.favoriteService.serialize(favorite);
  }

  /**
   * Marks a screenshot as viewed by the authenticated creator.
   */
  @Post(':id/views')
  public async markViewed(
    @Req() req: FastifyRequest,
    @Param('id') screenshotId: string
  ): Promise<JsonObject> {
    const { creator } = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

    const view = await this.viewService.markViewed(screenshotId, creator.id);

    return this.viewService.serialize(view);
  }

  /**
   * Reports a screenshot as inappropriate.
   *
   * Note: the request body is empty as of now as there are no other information to transmit.
   * This could change if we allow users to provide a reason for the report.
   */
  @Post(':id/reports')
  public async report(
    @Req() req: FastifyRequest,
    @Param('id') screenshotId: string
  ): Promise<JsonObject> {
    try {
      const { creator } = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

      const screenshot = await this.screenshotService.markReported(screenshotId, creator.id);

      return this.screenshotService.serialize(screenshot, req);
    } catch (error) {
      if (isPrismaError(error) && error.code == 'P2025') {
        throw new BadRequestException(`Could not find Screenshot #${screenshotId}.`, {
          cause: error
        });
      }

      throw error;
    }
  }

  /**
   * Receives a screenshot and its metadata and processes it to add it to the Hall of Fame.
   *
   * Expects a multipart request with the following fields:
   * - `creatorId`: The Creator ID.
   * - `cityName`: The name of the city.
   * - `cityMilestone`: The milestone reached by the city.
   * - `cityPopulation`: The population of the city.
   * - `screenshot`: The screenshot file, a JPEG.
   *
   * Response will be 201 with serialized Screenshot.
   */
  @Post()
  public async upload(
    @Req() req: FastifyRequest,
    @Query('healthcheck', new ParseBoolPipe({ optional: true }))
    healthcheck = false
  ): Promise<JsonObject> {
    const { authorization, creator } = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

    const multipart = await req.file({
      isPartAFile: fieldName => fieldName == 'screenshot',
      limits: {
        files: 1,
        fields: 6,
        fileSize: config.screenshots.maxFileSizeBytes
      }
    });

    if (!multipart) {
      throw new InvalidPayloadError(`Expected a file-field named 'screenshot'.`);
    }

    const cityName = this.validateCityName(this.getMultipartString(multipart, 'cityName', true));

    const cityMilestone = this.validateMilestone(
      this.getMultipartString(multipart, 'cityMilestone', true)
    );

    const cityPopulation = this.validatePopulation(
      this.getMultipartString(multipart, 'cityPopulation', true)
    );

    const paradoxModIds = this.validateModIds(this.getMultipartString(multipart, 'modIds', false));

    const renderSettings = this.validateRenderSettings(
      this.getMultipartString(multipart, 'renderSettings', false)
    );

    const metadata = this.validateMetadata(this.getMultipartString(multipart, 'metadata', false));

    try {
      const file = await multipart.toBuffer();

      const screenshot = await this.screenshotService.ingestScreenshot({
        ip: authorization.ip,
        hwid: authorization.hwid,
        creator,
        cityName,
        cityMilestone,
        cityPopulation,
        paradoxModIds,
        renderSettings,
        metadata,
        createdAt: new Date(),
        file,
        healthcheck
      });

      return this.screenshotService.serialize({ ...screenshot, creator }, req);
    } catch (error) {
      if (error instanceof Error && error.message.includes('format')) {
        throw new InvalidImageFormatError(error);
      }

      throw error;
    }
  }

  private getMultipartString(multipart: Multipart, fieldName: string, strict: true): string;

  private getMultipartString(
    multipart: Multipart,
    fieldName: string,
    strict: false
  ): string | undefined;

  private getMultipartString(
    multipart: Multipart,
    fieldName: string,
    strict = true
  ): string | undefined {
    const field = multipart.fields[fieldName];

    if (!(field && 'value' in field)) {
      if (!strict) {
        return;
      }

      throw new InvalidPayloadError(`Expected a multipart field named '${fieldName}'.`);
    }

    const value = String(field.value).trim();

    if (!value) {
      throw new InvalidPayloadError(`Expected a non-empty string for the field '${fieldName}'.`);
    }

    return value;
  }

  private validateCityName(name: string): string {
    if (!name.match(ScreenshotController.cityNameRegex)) {
      throw new InvalidCityNameError(name);
    }

    return name;
  }

  private validateMilestone(milestone: string): number {
    const parsed = Number.parseInt(milestone, 10);

    if (Number.isNaN(parsed) || parsed < 0 || parsed > 20) {
      throw new InvalidPayloadError(
        `Invalid milestone, it must be a positive integer between 0 and 20.`
      );
    }

    return parsed;
  }

  private validatePopulation(population: string): number {
    const parsed = Number.parseInt(population, 10);

    if (Number.isNaN(parsed) || parsed < 0 || parsed > 5_000_000) {
      throw new InvalidPayloadError(`Invalid population number, it must be a positive integer.`);
    }

    return parsed;
  }

  private validateModIds(commaSeparatedModIds: string | undefined): Set<ParadoxModId> {
    if (!commaSeparatedModIds) {
      return new Set();
    }

    const modIds = commaSeparatedModIds.split(',').map(id => {
      const parsed = Number.parseInt(id.trim(), 10);

      if (Number.isNaN(parsed) || parsed < 1) {
        throw new InvalidPayloadError(
          `Mod IDs must be positive integers and separated by a comma.`
        );
      }

      return parsed as ParadoxModId;
    });

    return new Set(modIds);
  }

  private validateRenderSettings(settingsJson: string | undefined): Record<string, number> {
    if (!settingsJson) {
      return {};
    }

    try {
      const settings = JSON.parse(settingsJson);

      if (typeof settings != 'object' || Array.isArray(settings)) {
        // noinspection ExceptionCaughtLocallyJS
        throw new Error(`expected a JSON object`);
      }

      return Object.entries(settings).reduce<Record<string, number>>((map, [key, value]) => {
        if (typeof value != 'number') {
          throw new Error(`expected a number value for the key "${key}", got "${value}"`);
        }

        map[key] = value;

        return map;
      }, {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new InvalidPayloadError(`Invalid JSON for render settings field (${message}).`, {
        cause: error
      });
    }
  }

  private validateMetadata(metadataJson: string | undefined): JsonObject {
    if (!metadataJson) {
      return {};
    }

    try {
      const metadata = JSON.parse(metadataJson);

      if (typeof metadata != 'object' || Array.isArray(metadata)) {
        // noinspection ExceptionCaughtLocallyJS
        throw new Error(`expected a JSON object`);
      }

      return metadata;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new InvalidPayloadError(`Invalid JSON for the metadata field (${message}).`, {
        cause: error
      });
    }
  }
}

abstract class UploadError extends StandardError {}

/**
 * Error class for invalid payloads, but it should not happen for users using the actual mod.
 * This should only happen in testing, or eventually if people want to implement a custom client in
 * good faith, otherwise we could also ban IPs with failed attempts.
 */
class InvalidPayloadError extends UploadError {}

class InvalidCityNameError extends UploadError {
  public readonly incorrectName: string;

  public constructor(incorrectName: string) {
    super(
      oneLine`
      City name "${incorrectName}" is invalid, it must contain only
      letters, numbers, spaces, hyphens and apostrophes, and be between 1
      and 25 characters long.`
    );

    this.incorrectName = incorrectName;
  }
}

class InvalidImageFormatError extends UploadError {
  public constructor(cause: unknown) {
    super(`Invalid image format, expected a JPEG file.`, { cause });
  }
}
