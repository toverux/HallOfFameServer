import type { Multipart } from '@fastify/multipart';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Inject,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import { oneLine } from 'common-tags';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { Prisma, type Screenshot } from '#prisma-lib/client';
import type { ParadoxModId } from '../../../shared/utils/branded-types';
import type { JsonObject } from '../../../shared/utils/json';
import { nn } from '../../../shared/utils/type-assertion';
import { isPrismaError } from '../../common/prisma-errors';
import { ForbiddenError, NotFoundByIdError, StandardError } from '../../common/standard-error';
import { config } from '../../config';
import { CreatorAuthorizationGuard } from '../../guards';
import { ZodParsePipe } from '../../pipes';
import {
  type CreatorIdentifier,
  FavoriteService,
  ModService,
  PrismaService,
  ScreenshotService,
  ScreenshotStorageService,
  ViewService
} from '../../services';

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

  /** @see updateOne */
  private static readonly updateScreenshotBodySchema = z.strictObject({
    cityName: z.string().optional(),
    showcasedModId: z.string().optional(),
    description: z.string().optional(),
    shareParadoxModIds: z.boolean().optional(),
    shareRenderSettings: z.boolean().optional()
  });

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(ModService)
  private readonly modService!: ModService;

  @Inject(FavoriteService)
  private readonly favoriteService!: FavoriteService;

  @Inject(ScreenshotService)
  private readonly screenshotService!: ScreenshotService;

  @Inject(ScreenshotStorageService)
  private readonly screenshotStorageService!: ScreenshotStorageService;

  @Inject(ViewService)
  private readonly viewService!: ViewService;

  /**
   * Retrieves all screenshots optionally filtered by a specific creator ID.
   * Provides additional metadata such as favorited status if the user is authenticated.
   */
  @Get()
  public async getAll(
    @Req() req: FastifyRequest,
    @Query('creatorId') creatorId: CreatorIdentifier | undefined,
    @Query('favorites', new ParseBoolPipe({ optional: true })) includeFavorites = false,
    @Query('views', new ParseBoolPipe({ optional: true })) includeViews = false,
    @Query('showcasedMod', new ParseBoolPipe({ optional: true })) includeShowcasedMod = false
  ): Promise<JsonObject[]> {
    if (!creatorId && (includeFavorites || includeViews || includeShowcasedMod)) {
      throw new BadRequestException(
        oneLine`
        The 'favorites', 'views' and 'showcasedMods' include query parameters are only supported
        when filtering by creator ID.`
      );
    }

    const creator = req[CreatorAuthorizationGuard.authenticatedCreatorKey];

    // If the creatorId filter is not an ObjectId or 'me', try to find by Creator name.
    if (typeof creatorId == 'string' && creatorId != 'me' && !ObjectId.isValid(creatorId)) {
      const creator = await this.prisma.creator.findFirst({
        select: { id: true },
        where: {
          // biome-ignore lint/style/useNamingConvention: prisma
          OR: [
            { creatorName: { equals: creatorId, mode: 'insensitive' } },
            { creatorNameSlug: creatorId }
          ]
        }
      });

      if (!creator) {
        throw new NotFoundByIdError(creatorId);
      }

      // biome-ignore lint/style/noParameterAssign: legitimate use case
      creatorId = creator?.id;
    }
    // If the creatorId filter is 'me', replace it with the logged-in creator ID.
    else if (creatorId == 'me') {
      // biome-ignore lint/style/noParameterAssign: legitimate use case
      creatorId = CreatorAuthorizationGuard.getAuthenticatedCreator(req).id;
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
      creator &&
      (await this.favoriteService.isFavoriteBatched(
        screenshots.map(s => s.id),
        creator
      ));

    // Find all showcased mods.
    const showcasedModIds = includeShowcasedMod
      ? screenshots.map(s => s.showcasedModId as ParadoxModId).filter(id => id != null)
      : [];

    const showcasedMods = includeShowcasedMod
      ? await this.modService.getMods(new Set(showcasedModIds))
      : [];

    return screenshots.map((screenshot, index) => {
      const showcasedMod = includeShowcasedMod
        ? (showcasedMods.find(mod => mod.paradoxModId == screenshot.showcasedModId) ?? null)
        : undefined;

      const payload = this.screenshotService.serialize({ ...screenshot, showcasedMod }, req);

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
    @Param('id') id: Screenshot['id'],
    @Query('favorites', new ParseBoolPipe({ optional: true })) includeFavorites = false,
    @Query('views', new ParseBoolPipe({ optional: true })) includeViews = false
  ): Promise<JsonObject> {
    const creator = req[CreatorAuthorizationGuard.authenticatedCreatorKey];

    const screenshot = await this.prisma.screenshot.findUnique({
      where: { id },
      include: {
        creator: true,
        favorites: includeFavorites ? { include: { creator: true } } : Prisma.skip,
        views: includeViews ? { include: { creator: true } } : Prisma.skip
      }
    });

    if (!screenshot) {
      throw new NotFoundByIdError(id);
    }

    const showcasedMod = screenshot.showcasedModId
      ? await this.modService.getMod(screenshot.showcasedModId as ParadoxModId)
      : null;

    const payload = this.screenshotService.serialize({ ...screenshot, showcasedMod }, req);

    // If the user is authenticated, we check if the screenshot is already in their favorites.
    // Otherwise, set it to false.
    payload.__favorited =
      creator != null && (await this.favoriteService.isFavorite(screenshot.id, creator));

    return payload;
  }

  /**
   * From a screenshot ID and a format (ex. "thumbnail.jpg", "fhd.jpg", "4k.jpg"), redirects to the
   * actual image served by the CDN.
   * Useful to get a screenshot URL when only the ID is known, also acts as a URL shortener
   * (compared to long blob URLs).
   */
  @Get(':id/:type')
  public async redirectToScreenshot(
    @Res() res: FastifyReply,
    @Param('id') id: Screenshot['id'],
    @Param('type') type: string
  ): Promise<void> {
    const screenshot = await this.prisma.screenshot.findUnique({ where: { id } });

    if (!screenshot) {
      throw new NotFoundByIdError(id);
    }

    const urls: Record<string, string> = {
      'thumbnail.jpg': screenshot.imageUrlThumbnail,
      'fhd.jpg': screenshot.imageUrlFHD,
      '4k.jpg': screenshot.imageUrl4K
    };

    const url = urls[type] && this.screenshotStorageService.getScreenshotUrl(urls[type]);

    if (!url) {
      throw new BadRequestException(
        `Unknown screenshot type ${type}, available types are: ${Object.keys(urls).join(', ')}`
      );
    }

    res.redirect(
      url,
      config.env == 'development' ? HttpStatus.FOUND : HttpStatus.MOVED_PERMANENTLY
    );
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
   * @param popular       Weight for the "popular" algorithm, see
   *                      {@link ScreenshotService.getScreenshotPopular}.
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
    @Query('popular', new ParseIntPipe({ optional: true }))
    popular = 0,
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
    const creator = req[CreatorAuthorizationGuard.authenticatedCreatorKey];

    const weights = { random, popular, trending, recent, archeologist, supporter };

    const screenshot = await this.screenshotService.getWeightedRandomScreenshot(
      weights,
      creator?.id,
      viewMaxAge
    );

    const showcasedMod = screenshot.showcasedModId
      ? await this.modService.getMod(screenshot.showcasedModId as ParadoxModId)
      : null;

    const createdBy = await this.prisma.creator.findFirst({
      where: { id: screenshot.creatorId }
    });

    nn.assert(createdBy);

    const payload = this.screenshotService.serialize(
      { ...screenshot, showcasedMod, creator: createdBy },
      req
    );

    payload.__algorithm = screenshot.__algorithm;

    // If the user is authenticated, we check if the screenshot is already in their favorites.
    // Otherwise, set it to false.
    payload.__favorited =
      creator != null && (await this.favoriteService.isFavorite(screenshot.id, creator));

    return payload;
  }

  /**
   * Delete a screenshot by ID.
   *
   * @throws NotFoundByIdError If the screenshot cannot be found.
   * @throws ForbiddenError    If the authenticated creator is not the one who posted the
   *                           screenshot.
   */
  @Delete(':id')
  public async deleteOne(
    @Req() req: FastifyRequest,
    @Param('id') id: Screenshot['id']
  ): Promise<JsonObject> {
    const creator = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

    const screenshot = await this.prisma.screenshot.findUnique({
      where: { id },
      select: { creatorId: true }
    });

    if (!screenshot) {
      throw new NotFoundByIdError(id);
    }

    if (screenshot.creatorId != creator.id) {
      throw new ForbiddenError(`You cannot delete screenshots that are not yours.`);
    }

    const deletedScreenshot = await this.screenshotService.deleteScreenshot(id);

    return this.screenshotService.serialize(deletedScreenshot, req);
  }

  /**
   * Update a screenshot by ID.
   * Only these properties can be updated:
   * - {@link Screenshot.cityName}
   * - {@link Screenshot.showcasedModId}
   * - {@link Screenshot.description}
   * - {@link Screenshot.shareParadoxModIds}
   * - {@link Screenshot.shareRenderSettings}
   *
   * @throws NotFoundByIdError If the screenshot cannot be found.
   * @throws ForbiddenError    If the authenticated creator is not the one who posted the
   *                           screenshot.
   */
  @Put(':id')
  public async updateOne(
    @Req() req: FastifyRequest,
    @Param('id') screenshotId: Screenshot['id'],
    @Body(new ZodParsePipe(ScreenshotController.updateScreenshotBodySchema))
    body: z.infer<typeof ScreenshotController.updateScreenshotBodySchema>
  ): Promise<JsonObject> {
    const authenticatedCreator = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

    const screenshot = await this.prisma.screenshot.findUnique({
      where: { id: screenshotId },
      select: { creatorId: true }
    });

    if (!screenshot) {
      throw new NotFoundByIdError(screenshotId);
    }

    if (authenticatedCreator.id != screenshot.creatorId) {
      throw new ForbiddenError(`You cannot update screenshots that are not yours.`);
    }

    const cityName = body.cityName && this.validateCityName(body.cityName);
    const showcasedModId = Array.from(this.validateModIds(body.showcasedModId)).at(0);

    const updatedScreenshot = await this.screenshotService.updateScreenshot(screenshotId, {
      cityName: cityName ?? Prisma.skip,
      showcasedModId: showcasedModId ?? Prisma.skip,
      description: body.description ?? Prisma.skip,
      shareParadoxModIds: body.shareParadoxModIds ?? Prisma.skip,
      shareRenderSettings: body.shareRenderSettings ?? Prisma.skip
    });

    return this.screenshotService.serialize(updatedScreenshot, req);
  }

  /**
   * Adds the screenshot to the authenticated creator's favorites.
   * We also verify that the screenshot was not already favorited using the same IP or HWID, as
   * multi-accounting on favorites is not allowed.
   */
  @Post(':id/favorites')
  public async addToFavorites(
    @Req() req: FastifyRequest,
    @Param('id') screenshotId: Screenshot['id']
  ): Promise<JsonObject> {
    const creator = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

    const favorite = await this.favoriteService.addFavorite(screenshotId, creator);

    return this.favoriteService.serialize(favorite);
  }

  /**
   * Deletes the screenshot from the authenticated creator's favorites.
   */
  @Delete(':id/favorites/mine')
  public async removeFromFavorites(
    @Req() req: FastifyRequest,
    @Param('id') screenshotId: Screenshot['id']
  ): Promise<JsonObject> {
    const creator = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

    const favorite = await this.favoriteService.removeFavorite(screenshotId, creator);

    return this.favoriteService.serialize(favorite);
  }

  /**
   * Marks a screenshot as viewed by the authenticated creator.
   */
  @Post(':id/views')
  public async markViewed(
    @Req() req: FastifyRequest,
    @Param('id') screenshotId: Screenshot['id']
  ): Promise<JsonObject> {
    const creator = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

    const view = await this.viewService.markViewed(screenshotId, creator.id);

    return this.viewService.serialize(view);
  }

  /**
   * Reports a screenshot as inappropriate.
   *
   * Note: the request body is empty as of now as there is no other information to transmit.
   * This could change if we allow users to provide a reason for the report.
   */
  @Post(':id/reports')
  public async report(
    @Req() req: FastifyRequest,
    @Param('id') screenshotId: Screenshot['id']
  ): Promise<JsonObject> {
    try {
      const creator = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

      const screenshot = await this.screenshotService.markReported(screenshotId, creator.id);

      return this.screenshotService.serialize(screenshot, req);
    } catch (error) {
      if (isPrismaError(error) && error.code == 'P2025') {
        throw new NotFoundByIdError(screenshotId, { cause: error });
      }

      throw error;
    }
  }

  /**
   * Receives a screenshot and its metadata and processes it to add it to the Hall of Fame.
   *
   * Expects a multipart request with the following fields:
   * - `cityName` (required): The name of the city.
   * - `cityMilestone` (required): The milestone reached by the city.
   * - `cityPopulation` (required): The population of the city.
   * - `mapName`: Name of the omap that was used to create this game.
   * - `showcasedModId`: The ID of a mod that is showcased in the screenshot.
   * - `description`: A short description for the screenshot.
   * - `shareParadoxModIds`: Whether to share the mods used in the screenshot.
   * - `modIds`: A comma-separated list of Paradox Mod IDs.
   * - `shareRenderSettings`: Whether to share the photo mode settings for the screenshots.
   * - `renderSettings`: A JSON string containing the render settings for the screenshot.
   * - `metadata`: A JSON string containing additional metadata about the screenshot that is not
   *   exploited by the application.
   * - `screenshot` (required): The screenshot file, a JPEG.
   *
   * Response will be 201 with a serialized Screenshot.
   */
  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: inherently sequential, but we will refactor using a proper validator.
  @Post()
  public async upload(
    @Req() req: FastifyRequest,
    @Query('healthcheck', new ParseBoolPipe({ optional: true }))
    healthcheck = false
  ): Promise<JsonObject> {
    const creator = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

    // noinspection JSUnusedGlobalSymbols False positive.
    const multipart = await req.file({
      isPartAFile: fieldName => fieldName == 'screenshot',
      limits: {
        // Number of fields we expect to receive at most.
        fields: 11,
        files: 1,
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

    const mapName = this.getMultipartString(multipart, 'mapName', false);

    const showcasedModId = Array.from(
      this.validateModIds(this.getMultipartString(multipart, 'showcasedModId', false))
    ).at(0);

    const description = this.validateDescription(
      this.getMultipartString(multipart, 'description', false)
    );

    const shareParadoxModIds = this.getMultipartString(multipart, 'shareModIds', false) == 'true';

    const paradoxModIds = this.validateModIds(this.getMultipartString(multipart, 'modIds', false));

    const shareRenderSettings =
      this.getMultipartString(multipart, 'shareRenderSettings', false) == 'true';

    const renderSettings = this.validateRenderSettings(
      this.getMultipartString(multipart, 'renderSettings', false)
    );

    const metadata = this.validateMetadata(this.getMultipartString(multipart, 'metadata', false));

    try {
      const file = await multipart.toBuffer();

      const screenshot = await this.screenshotService.ingestScreenshot({
        creator,
        cityName,
        cityMilestone,
        cityPopulation,
        mapName,
        showcasedModId,
        description,
        shareParadoxModIds,
        paradoxModIds,
        shareRenderSettings,
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
        return undefined;
      }

      throw new InvalidPayloadError(`Expected a multipart field named '${fieldName}'.`);
    }

    const value = String(field.value).trim();

    if (!value) {
      return undefined;
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

  private validateDescription(description: string | undefined): string | undefined {
    if (!description) {
      return undefined;
    }

    if (description.length > 4000) {
      throw new InvalidPayloadError(`Description must be at most 4000 characters long.`);
    }

    return description;
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

      if (!settings || typeof settings != 'object' || Array.isArray(settings)) {
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

      if (!metadata || typeof metadata != 'object' || Array.isArray(metadata)) {
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

abstract class UploadError extends StandardError {
  public override httpErrorType = BadRequestException;
}

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
      City name "${incorrectName}" is invalid, it must contain only letters, numbers, spaces,
      hyphens and apostrophes, and be between 1 and 25 characters long.`
    );

    this.incorrectName = incorrectName;
  }
}

class InvalidImageFormatError extends UploadError {
  public constructor(cause: unknown) {
    super(`Invalid image format, expected a JPEG file.`, { cause });
  }
}
