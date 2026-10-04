import type { Multipart } from '@fastify/multipart';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { inspect } from 'bun';
import { oneLine } from 'common-tags';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { Prisma, type Screenshot } from '#prisma-lib/client';
import type { ParadoxModId } from '../../../shared/utils/branded-types';
import type { JsonObject, JsonValue } from '../../../shared/utils/json';
import { viewerBaseUrl } from '../../common/constants';
import { isPrismaError } from '../../common/prisma-errors';
import { ForbiddenError, NotFoundByIdError, StandardError } from '../../common/standard-error';
import { config } from '../../config';
import { CreatorAuthorizationGuard } from '../../guards';
import { ZodParsePipe } from '../../pipes';
import {
  CreatorAuthenticationService,
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
   * @see updateOne
   */
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
  // oxlint-disable-next-line max-params - NestJS handler; params are decorator-bound
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

    const creator = req[CreatorAuthenticationService.authenticatedCreatorKey];

    let resolvedCreatorId = creatorId;

    // If the creatorId filter is not an ObjectId or 'me', try to find by Creator name.
    if (
      typeof resolvedCreatorId == 'string' &&
      resolvedCreatorId != 'me' &&
      !ObjectId.isValid(resolvedCreatorId)
    ) {
      const creatorByName = await this.prisma.creator.findFirst({
        select: { id: true },
        where: {
          OR: [
            { creatorName: { equals: resolvedCreatorId, mode: 'insensitive' } },
            { creatorNameSlug: resolvedCreatorId }
          ]
        }
      });

      if (!creatorByName) {
        throw new NotFoundByIdError(resolvedCreatorId);
      }

      resolvedCreatorId = creatorByName.id;
    }
    // If the creatorId filter is 'me', replace it with the logged-in creator ID.
    else if (resolvedCreatorId == 'me') {
      resolvedCreatorId = CreatorAuthenticationService.getAuthenticatedCreator(req).id;
    }

    const screenshots = await this.prisma.screenshot.findMany({
      where: { creatorId: resolvedCreatorId ?? Prisma.skip },
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
        screenshots.map(screenshot => screenshot.id),
        creator
      ));

    // Find all showcased mods.
    const showcasedModIds = includeShowcasedMod
      ? screenshots
          .map(screenshot => screenshot.showcasedModId as ParadoxModId)
          .filter(id => id != null)
      : [];

    const showcasedMods = includeShowcasedMod
      ? await this.modService.getMods(new Set(showcasedModIds))
      : [];

    return screenshots.map((screenshot, index) => {
      const showcasedMod = includeShowcasedMod
        ? (showcasedMods.find(mod => mod.paradoxModId == screenshot.showcasedModId) ?? null)
        : undefined;

      const payload = this.screenshotService.serialize({ ...screenshot, showcasedMod }, req);

      // oxlint-disable-next-line no-underscore-dangle
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
    const creator = req[CreatorAuthenticationService.authenticatedCreatorKey];

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
    // oxlint-disable-next-line no-underscore-dangle
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
   * Redirects to the screenshot's page on the external HoF web viewer and increments
   * {@link Screenshot.viewerClicksCount}.
   */
  @Get(':id/viewer')
  public async redirectToViewerPage(
    @Res() res: FastifyReply,
    @Param('id') id: Screenshot['id']
  ): Promise<void> {
    const screenshot = await this.prisma.screenshot.findUnique({
      where: { id },
      select: { id: true }
    });

    if (!screenshot) {
      throw new NotFoundByIdError(id);
    }

    // Increment viewer click count for this screenshot, before redirecting so the count is saved
    // once the client gets the response.
    await this.prisma.screenshot.update({
      where: { id },
      data: { viewerClicksCount: { increment: 1 } }
    });

    res.redirect(`${viewerBaseUrl}/city/${id}`, HttpStatus.TEMPORARY_REDIRECT);
  }

  /**
   * Returns the list of mods used in that screenshot.
   */
  @Get(':id/playset')
  public async getPlayset(@Param('id') id: Screenshot['id']): Promise<JsonObject[]> {
    const screenshot = await this.prisma.screenshot.findUnique({ where: { id } });

    if (!screenshot) {
      throw new NotFoundByIdError(id);
    }

    if (!screenshot.shareParadoxModIds) {
      throw new PlaysetNotSharedError();
    }

    const mods = await this.modService.getMods(new Set(screenshot.paradoxModIds as ParadoxModId[]));

    return mods.map(mod => this.modService.serialize(mod));
  }

  /**
   * Returns a random screenshot.
   * Different algorithms can be used to select the screenshot randomly, to each algorithm a
   * weight can be assigned to favor one method over others.
   * See {@link ScreenshotService} for the description of the algorithms.
   * By default, all weights are zero and "random" is used.
   *
   * @param req The request object.
   * @param random Weight for the "random" algorithm, see
   *   {@link ScreenshotService.getScreenshotRandom}.
   * @param popular Weight for the "popular" algorithm, see
   *   {@link ScreenshotService.getScreenshotPopular}.
   * @param trending Weight for the "trending" algorithm, see
   *   {@link ScreenshotService.getScreenshotTrending}.
   * @param recent Weight for the "recent" algorithm, see
   *   {@link ScreenshotService.getScreenshotRecent}.
   * @param archeologist Weight for the "archeologist" algorithm, see
   *   {@link ScreenshotService.getScreenshotArcheologist}.
   * @param supporter Weight for the "supporter" algorithm, see
   *   {@link ScreenshotService.getScreenshotSupporter}.
   * @param viewMaxAge Min time in days before showing a screenshot the user has already seen.
   *   Default is 60, 0 is no limit.
   */
  @Get('weighted')
  // oxlint-disable-next-line max-params - NestJS handler; params are decorator-bound
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
  ): Promise<JsonObject> {
    const creator = req[CreatorAuthenticationService.authenticatedCreatorKey];

    const weights = { random, popular, trending, recent, archeologist, supporter };

    const totalWeight = Object.values(weights).reduce((total, weight) => total + weight, 0);

    // Out of these bounds, the weighted pick would never end.
    if (Object.values(weights).some(weight => weight < 0) || !Number.isSafeInteger(totalWeight)) {
      throw new BadRequestException(
        oneLine`
        Algorithm weights must be positive integers or zero,
        totaling at most ${Number.MAX_SAFE_INTEGER}.`
      );
    }

    const screenshot = await this.screenshotService.getWeightedRandomScreenshot(
      weights,
      creator?.id,
      viewMaxAge
    );

    const showcasedMod = screenshot.showcasedModId
      ? await this.modService.getMod(screenshot.showcasedModId as ParadoxModId)
      : null;

    const payload = this.screenshotService.serialize({ ...screenshot, showcasedMod }, req);

    // oxlint-disable-next-line no-underscore-dangle
    payload.__algorithm = screenshot.__algorithm;

    // If the user is authenticated, we check if the screenshot is already in their favorites.
    // Otherwise, set it to false.
    // oxlint-disable-next-line no-underscore-dangle
    payload.__favorited =
      creator != null && (await this.favoriteService.isFavorite(screenshot.id, creator));

    return payload;
  }

  /**
   * Delete a screenshot by ID.
   *
   * @throws {NotFoundByIdError} If the screenshot cannot be found.
   * @throws {ForbiddenError} If the authenticated creator is not the one who posted the
   * screenshot.
   */
  @Delete(':id')
  public async deleteOne(
    @Req() req: FastifyRequest,
    @Param('id') id: Screenshot['id']
  ): Promise<JsonObject> {
    const creator = CreatorAuthenticationService.getAuthenticatedCreator(req);

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
   * @throws {NotFoundByIdError} If the screenshot cannot be found.
   * @throws {ForbiddenError} If the authenticated creator is not the one who posted the
   * screenshot.
   */
  @Put(':id')
  public async updateOne(
    @Req() req: FastifyRequest,
    @Param('id') screenshotId: Screenshot['id'],
    @Body(new ZodParsePipe(ScreenshotController.updateScreenshotBodySchema))
    body: z.infer<typeof ScreenshotController.updateScreenshotBodySchema>
  ): Promise<JsonObject> {
    const authenticatedCreator = CreatorAuthenticationService.getAuthenticatedCreator(req);

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

    const cityName = body.cityName == null ? undefined : validateCityName(body.cityName);
    const showcasedModId = Array.from(validateModIds(body.showcasedModId)).at(0);

    const updatedScreenshot = await this.screenshotService.updateScreenshot(screenshotId, {
      cityName: cityName ?? Prisma.skip,
      showcasedModId: showcasedModId ?? Prisma.skip,
      // An empty description clears it, as an upload without one.
      description:
        body.description == null ? Prisma.skip : (validateDescription(body.description) ?? null),
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
    const creator = CreatorAuthenticationService.getAuthenticatedCreator(req);

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
    const creator = CreatorAuthenticationService.getAuthenticatedCreator(req);

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
    const creator = CreatorAuthenticationService.getAuthenticatedCreator(req);

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
      const creator = CreatorAuthenticationService.getAuthenticatedCreator(req);

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
   * - `description`: A short description for the screenshot, without link or image markdown.
   * - `shareModIds`: Whether to share the mods used in the screenshot.
   * - `modIds`: A comma-separated list of Paradox Mod IDs.
   * - `shareRenderSettings`: Whether to share the photo mode settings and conditions of the shot.
   * - `renderSettings`: A JSON string containing the render settings for the screenshot.
   * - `renderConditions`: A JSON string containing the scene and light conditions of the shot.
   * - `metadata`: A JSON string containing additional metadata about the screenshot that is not
   * exploited by the application.
   * - `screenshot` (required): The screenshot file, a JPEG.
   *
   * Response will be 201 with a serialized Screenshot.
   */
  @Post()
  public async upload(
    @Req() req: FastifyRequest,
    @Query('healthcheck', new ParseBoolPipe({ optional: true }))
    healthcheck = false
  ): Promise<JsonObject> {
    const creator = CreatorAuthenticationService.getAuthenticatedCreator(req);

    // noinspection JSUnusedGlobalSymbols False positive.
    const multipart = await req.file({
      isPartAFile: fieldName => fieldName == 'screenshot',
      limits: {
        // Number of fields we expect to receive at most, raised with each new upload field.
        // Exceeding it fails the upload with a 500 "Premature close", not a 400.
        fields: 12,
        files: 1,
        fileSize: config.screenshots.maxFileSizeBytes
      }
    });

    if (!multipart) {
      throw new InvalidPayloadError(`Expected a file-field named 'screenshot'.`);
    }

    const cityName = validateCityName(this.getMultipartString(multipart, 'cityName', true));

    const cityMilestone = validateMilestone(
      this.getMultipartString(multipart, 'cityMilestone', true)
    );

    const cityPopulation = validatePopulation(
      this.getMultipartString(multipart, 'cityPopulation', true)
    );

    const mapName = this.getMultipartString(multipart, 'mapName', false);

    const showcasedModId = Array.from(
      validateModIds(this.getMultipartString(multipart, 'showcasedModId', false))
    ).at(0);

    const description = validateDescription(
      this.getMultipartString(multipart, 'description', false)
    );

    const shareParadoxModIds = this.getMultipartString(multipart, 'shareModIds', false) != 'false';

    const paradoxModIds = validateModIds(this.getMultipartString(multipart, 'modIds', false));

    const shareRenderSettings =
      this.getMultipartString(multipart, 'shareRenderSettings', false) != 'false';

    const renderSettings = validateRenderSettings(
      this.getMultipartString(multipart, 'renderSettings', false)
    );

    const renderConditions = validateRenderConditions(
      this.getMultipartString(multipart, 'renderConditions', false)
    );

    const metadata = validateMetadata(this.getMultipartString(multipart, 'metadata', false));

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
        renderConditions,
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
    strict: boolean
  ): string | undefined {
    const field = multipart.fields[fieldName];

    // A blank field counts as missing.
    const value = field && 'value' in field ? String(field.value).trim() : '';

    if (value != '') {
      return value;
    }

    if (strict) {
      throw new InvalidPayloadError(`Expected a multipart field named '${fieldName}'.`);
    }

    return undefined;
  }
}

/**
 * Regular expression to validate a trimmed city name:
 * - Must contain only letters, numbers, spaces, hyphens, apostrophes and commas (Latin, CJK), and
 * middle dots (the Chinese interpunct, and a bullet), with at least one letter or number.
 * - A letter or number may carry up to three combining marks, as scripts like Devanagari and Thai
 * need, where more only stack into unreadable text.
 * - Must be between 1 and 35 characters long. 1-character-long names are for languages like
 * Chinese.
 */
const cityNameRegex = /^(?=.{1,35}$)(?=.*[\p{L}\p{N}])(?:[\p{L}\p{N}]\p{M}{0,3}|[- '’,、·•])+$/u;

/**
 * Maximum accepted milestone value.
 */
const maxMilestone = 20;

/**
 * Maximum accepted city population.
 */
const maxPopulation = 5_000_000;

/**
 * Maximum accepted screenshot description length.
 */
const maxDescriptionLength = 4000;

/**
 * Maximum accepted length of the render conditions JSON.
 * It leaves the mod room to record more conditions in later versions without a server release.
 */
const maxRenderConditionsLength = 16_384;

/**
 * Matches link markdown, `[text](target)`, and image markdown, `![alt](url)`, as the game's
 * markdown renderer recognizes them.
 * It also matches one spanning line breaks, which the game never renders, as a safety margin.
 * A description cannot contain either: an image makes every viewer's client fetch the author's
 * URL, and a link renders as a focusable element that does nothing.
 * The text holds no brackets and the parentheses must follow the closing bracket directly, so
 * brackets and parentheses in ordinary prose do not match.
 */
const markdownLinkRegex = /!?\[[^[\]]*\]\([^)]*\)/u;

export function validateCityName(name: string): string {
  const trimmedName = name.trim();

  if (!cityNameRegex.test(trimmedName)) {
    throw new InvalidCityNameError(name);
  }

  return trimmedName;
}

export function validateMilestone(milestone: string): number {
  const parsed = Math.trunc(Number(milestone));

  if (Number.isNaN(parsed) || parsed < 0 || parsed > maxMilestone) {
    throw new InvalidPayloadError(
      oneLine`
      Invalid milestone, it must be a positive integer between 0 and
      ${maxMilestone}.`
    );
  }

  return parsed;
}

export function validatePopulation(population: string): number {
  const parsed = Math.trunc(Number(population));

  if (Number.isNaN(parsed) || parsed < 0 || parsed > maxPopulation) {
    throw new InvalidPayloadError(`Invalid population number, it must be a positive integer.`);
  }

  return parsed;
}

export function validateDescription(description: string | undefined): string | undefined {
  const trimmedDescription = description?.trim();

  if (!trimmedDescription) {
    return undefined;
  }

  if (trimmedDescription.length > maxDescriptionLength) {
    throw new InvalidPayloadError(
      `Description must be at most ${maxDescriptionLength} characters long.`
    );
  }

  const markdownLink = markdownLinkRegex.exec(trimmedDescription);

  if (markdownLink) {
    const [syntax] = markdownLink;

    const kind = syntax.startsWith('!') ? 'image' : 'link';

    throw new InvalidPayloadError(
      `Description cannot contain ${kind} markdown, found "${syntax}".`
    );
  }

  return trimmedDescription;
}

export function validateModIds(commaSeparatedModIds: string | undefined): Set<ParadoxModId> {
  if (!commaSeparatedModIds) {
    return new Set();
  }

  const modIds = commaSeparatedModIds.split(',').map(id => {
    const parsed = Math.trunc(Number(id.trim()));

    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new InvalidPayloadError(`Mod IDs must be positive integers and separated by a comma.`);
    }

    return parsed as ParadoxModId;
  });

  return new Set(modIds);
}

export function validateRenderSettings(settingsJson: string | undefined): Record<string, number> {
  return parseJsonObjectField(settingsJson, 'render settings field', (value, key) => {
    if (typeof value != 'number') {
      throw new TypeError(`expected a number value for the key "${key}", got "${inspect(value)}"`);
    }

    return value;
  });
}

export function validateRenderConditions(
  conditionsJson: string | undefined
): Record<string, number | string | boolean> {
  if (conditionsJson && conditionsJson.length > maxRenderConditionsLength) {
    throw new InvalidPayloadError(
      `Render conditions field must be at most ${maxRenderConditionsLength} characters long.`
    );
  }

  return parseJsonObjectField(conditionsJson, 'render conditions field', (value, key) => {
    if (typeof value != 'number' && typeof value != 'string' && typeof value != 'boolean') {
      throw new TypeError(
        oneLine`
        expected a number, string, or boolean value for the key "${key}",
        got "${inspect(value)}"`
      );
    }

    return value;
  });
}

export function validateMetadata(metadataJson: string | undefined): JsonObject {
  return parseJsonObjectField(metadataJson, 'the metadata field', value => value);
}

/**
 * Parses a field holding a JSON object, an absent or empty field giving an empty object.
 * `parseValue` validates each value, throwing an error whose message explains the rejection.
 */
function parseJsonObjectField<TValue>(
  json: string | undefined,
  fieldDescription: string,
  parseValue: (value: JsonObject[string], key: string) => TValue
): Record<string, TValue> {
  if (!json) {
    return {};
  }

  try {
    const parsed: JsonValue = JSON.parse(json);

    if (!parsed || typeof parsed != 'object' || Array.isArray(parsed)) {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error(`expected a JSON object`);
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, parseValue(value, key)])
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new InvalidPayloadError(`Invalid JSON for ${fieldDescription} (${message}).`, {
      cause: error
    });
  }
}

class PlaysetNotSharedError extends StandardError {
  public override httpErrorType = ForbiddenException;

  public constructor() {
    super(`The creator has decided not to share their playset for this screenshot.`);
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
      hyphens, apostrophes, commas, and middle dots, with at least one letter or number, and be
      between 1 and 35 characters long.`
    );

    this.incorrectName = incorrectName;
  }
}

class InvalidImageFormatError extends UploadError {
  public constructor(cause: unknown) {
    super(`Invalid image format, expected a JPEG file.`, { cause });
  }
}
