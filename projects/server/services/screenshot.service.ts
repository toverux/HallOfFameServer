import assert from 'node:assert/strict';
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap
} from '@nestjs/common';
import { oneLine } from 'common-tags';
import * as dfns from 'date-fns';
import type { FastifyRequest } from 'fastify';
import { filesize } from 'filesize';
import {
  type Creator,
  type Favorite,
  type Mod,
  Prisma,
  type Screenshot,
  type View
} from '#prisma-lib/client';
import type { ParadoxModId } from '../../shared/utils/branded-types';
import { type JsonObject, optionallySerialized } from '../../shared/utils/json';
import { nn } from '../../shared/utils/type-assertion';
import type { Maybe } from '../../shared/utils/utility-types';
import { isPrismaError } from '../common/prisma-errors';
import { NotFoundByIdError, StandardError } from '../common/standard-error';
import { config } from '../config';
import { AiTranslatorService } from './ai-translator.service';
import { BackgroundTasksService } from './background-tasks.service';
import { CreatorAuthenticationService } from './creator-authentication.service';
import { CreatorService, uniqueUserConditions } from './creator.service';
import { DateFnsLocalizationService } from './date-fns-localization.service';
import { FavoriteService } from './favorite.service';
import { ModService } from './mod.service';
import { PrismaService } from './prisma.service';
import { ScreenshotProcessingService } from './screenshot-processing.service';
import { ScreenshotSimilarityDetectorService } from './screenshot-similarity-detector.service';
import { ScreenshotStorageService } from './screenshot-storage.service';
import { ViewService } from './view.service';

type RandomScreenshotAlgorithm =
  | 'random'
  | 'popular'
  | 'trending'
  | 'recent'
  | 'archeologist'
  | 'supporter';

type RandomScreenshotWeights = Readonly<Record<RandomScreenshotAlgorithm, number>>;

type RandomScreenshotFunctions = Readonly<
  Record<
    RandomScreenshotAlgorithm,
    (nin: readonly JsonOid[]) => Promise<ScreenshotWithCreator | null>
  >
>;

type ScreenshotWithCreator = Screenshot & { creator: Creator };

type ScreenshotWithAlgo = ScreenshotWithCreator & {
  __algorithm: RandomScreenshotAlgorithm | 'random_default';
};

interface JsonOid extends Prisma.InputJsonObject {
  readonly $oid: string;
}

@Injectable()
export class ScreenshotService implements OnApplicationBootstrap {
  private static readonly sampleSizeForDeterministicAlgorithms = 100;

  /**
   * Timeout after which the upload process and database transaction are canceled.
   */
  private static readonly ingestScreenshotTransactionTimeout = 60_000;

  /**
   * The date each serialized field started holding what the mod captured, rather than a default:
   * the day the mod release capturing it reached players.
   * Read each from the first uploads carrying it: a release can reach players before its tag.
   * A Screenshot created earlier lacks the field in its `capabilities`.
   */
  private static readonly capabilitiesSince = {
    description: new Date('2026-01-16T00:00:00Z'),
    shareParadoxModIds: new Date('2026-01-16T00:00:00Z'),
    // This one and `renderSettings` come with mod 1.10.0, which reached players ahead of its tag.
    paradoxModIds: new Date('2025-03-30T00:00:00Z'),
    shareRenderSettings: new Date('2026-01-16T00:00:00Z'),
    renderSettings: new Date('2025-03-30T00:00:00Z'),
    // Placeholder until the mod release recording the conditions: set it to the day it reaches
    // players. An earlier date only makes screenshots without conditions claim the capability,
    // which clients treat like an empty map.
    renderConditions: new Date('2026-10-04T00:00:00Z')
  } as const satisfies Readonly<Record<string, Date>>;

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(DateFnsLocalizationService)
  private readonly dateFnsLocalization!: DateFnsLocalizationService;

  @Inject(AiTranslatorService)
  private readonly aiTranslator!: AiTranslatorService;

  @Inject(BackgroundTasksService)
  private readonly backgroundTasks!: BackgroundTasksService;

  @Inject(ModService)
  private readonly modService!: ModService;

  @Inject(CreatorService)
  private readonly creatorService!: CreatorService;

  @Inject(FavoriteService)
  private readonly favoriteService!: FavoriteService;

  @Inject(ViewService)
  private readonly viewService!: ViewService;

  @Inject(ScreenshotProcessingService)
  private readonly screenshotProcessing!: ScreenshotProcessingService;

  @Inject(ScreenshotSimilarityDetectorService)
  private readonly screenshotSimilarityDetector!: ScreenshotSimilarityDetectorService;

  @Inject(ScreenshotStorageService)
  private readonly screenshotStorage!: ScreenshotStorageService;

  private readonly logger = new Logger(ScreenshotService.name);

  private readonly randomScreenshotFunctions: RandomScreenshotFunctions = {
    random: this.getScreenshotRandom.bind(this),
    popular: this.getScreenshotPopular.bind(this),
    trending: this.getScreenshotTrending.bind(this),
    recent: this.getScreenshotRecent.bind(this),
    archeologist: this.getScreenshotArcheologist.bind(this),
    supporter: this.getScreenshotSupporter.bind(this)
  };

  private popularScreenshotsFavoritingPercentageThreshold = 0;

  public async onApplicationBootstrap(): Promise<void> {
    this.popularScreenshotsFavoritingPercentageThreshold =
      await this.getPopularFavoritingPercentageThreshold();

    this.logger.log(
      oneLine`
      Popular screenshots favoriting percentage threshold:
      ${this.popularScreenshotsFavoritingPercentageThreshold}%
      (percentile=${config.screenshots.popularScreenshotsPercentile},
      min favorites=${config.screenshots.popularScreenshotsMinFavorites}).`
    );
  }

  /**
   * Ingests a screenshot and its metadata into the Hall of Fame.
   *
   * By ingesting a screenshot, we mean:
   * - Resizing the screenshot to two sizes.
   * - Uploading the screenshots to Azure Blob Storage.
   * - Creating a {@link Screenshot} record in the database.
   * - Asynchronously requesting a translation for the city name (if required).
   * - Asynchronously inferring similarity embeddings for the screenshot.
   * - Asynchronously warming up the mods' cache from the used playset.
   */
  public async ingestScreenshot({
    healthcheck,
    ...data
  }: {
    creator: Pick<Creator, 'id' | 'creatorName' | 'creatorNameSlug' | 'hwids' | 'ips'>;
    cityName: string;
    cityMilestone: number;
    cityPopulation: number;
    mapName: string | undefined;
    showcasedModId: ParadoxModId | undefined;
    description: string | undefined;
    shareParadoxModIds: boolean | undefined;
    paradoxModIds: ReadonlySet<ParadoxModId>;
    shareRenderSettings: boolean | undefined;
    renderSettings: Record<string, number>;
    renderConditions: Record<string, number | string | boolean>;
    metadata: JsonObject;
    createdAt: Date;
    file: Buffer;
    healthcheck: boolean;
  }): Promise<Screenshot> {
    const startMark = Date.now();

    this.logger.log(
      oneLine`
      Ingesting screenshot "${data.cityName}" by "${data.creator.creatorName}"
      (#${data.creator.id}), size ${filesize(data.file.length)}.`
    );

    // Check upload limit, throws if reached.
    await this.checkUploadLimit(data.creator);

    let mark = Date.now();

    // Generate the two resized screenshots from the uploaded file.
    const { imageThumbnailBuffer, imageFhdBuffer, image4kBuffer } =
      await this.screenshotProcessing.resizeScreenshots(data.file, {
        creatorName: data.creator.creatorName,
        cityName: data.cityName
      });

    this.logger.log(`Screenshot "${data.cityName}" resized (${Date.now() - mark}ms).`);
    mark = Date.now();

    // Create the screenshot in the database and upload the screenshots in a transaction, so if
    // the upload fails, the database is not updated.
    const screenshot = await this.prisma.$transaction(saveScreenshotTransaction.bind(this), {
      timeout: ScreenshotService.ingestScreenshotTransactionTimeout
    });

    this.logger.log(
      oneLine`
      Screenshot "${data.cityName}" (#${screenshot.id}) uploaded and saved
      (${Date.now() - mark}ms).`
    );

    this.logger.log(
      oneLine`
      Ingested screenshot "${screenshot.cityName}" (#${screenshot.id})
      by "${data.creator.creatorName}" (#${data.creator.id})
      (total ${Date.now() - startMark}ms).`,
      this.screenshotStorage.getScreenshotUrl(screenshot.imageUrlFHD)
    );

    if (!healthcheck) {
      this.backgroundTasks.run(
        `Failed to translate city name "${screenshot.cityName}" (#${screenshot.id}).`,
        () => this.updateCityNameTranslation(screenshot)
      );

      this.backgroundTasks.run(
        oneLine`
        Failed to infer embeddings for screenshot "${screenshot.cityName}"
        (#${screenshot.id}).`,
        () =>
          this.screenshotSimilarityDetector.batchUpdateEmbeddings(screenshot.id, [
            { id: screenshot.id, imageUrlOrBuffer: imageFhdBuffer }
          ])
      );

      // Note: no need to include `showcasedModId` as it's necessarily included in `paradoxModIds`.
      const modIds = new Set(screenshot.paradoxModIds as ParadoxModId[]);

      this.backgroundTasks.run(
        oneLine`
        Failed to warmup mods cache for screenshot "${screenshot.cityName}"
        (#${screenshot.id}).`,
        () => this.modService.getMods(modIds)
      );
    }

    return screenshot;

    async function saveScreenshotTransaction(
      this: ScreenshotService,
      prisma: Prisma.TransactionClient
    ): Promise<Screenshot> {
      // Create the screenshot in the database.
      const screenshotWithoutBlobs = await prisma.screenshot.create({
        select: { id: true, cityName: true },
        data: {
          createdAt: data.createdAt,
          hwid: data.creator.hwids[0] ?? null,
          ip: data.creator.ips[0] ?? null,
          creatorId: data.creator.id,
          cityName: data.cityName,
          cityMilestone: data.cityMilestone,
          cityPopulation: data.cityPopulation,
          mapName: data.mapName ?? null,
          imageUrlThumbnail: '',
          imageUrlFHD: '',
          imageUrl4K: '',
          showcasedModId: data.showcasedModId ?? null,
          description: data.description ?? null,
          shareParadoxModIds: data.shareParadoxModIds ?? true,
          paradoxModIds: Array.from(data.paradoxModIds),
          shareRenderSettings: data.shareRenderSettings ?? true,
          renderSettings: data.renderSettings,
          renderConditions: data.renderConditions,
          metadata: data.metadata,
          isReported: healthcheck // Make sure health check uploads are never shown
        }
      });

      // Upload the screenshots.
      const blobUrls = await this.screenshotStorage.uploadScreenshots({
        creator: data.creator,
        screenshot: screenshotWithoutBlobs,
        bufferThumbnail: imageThumbnailBuffer,
        bufferFhd: imageFhdBuffer,
        buffer4K: image4kBuffer
      });

      // Update the screenshot with the blob URLs.
      const updatedScreenshot = await prisma.screenshot.update({
        where: { id: screenshotWithoutBlobs.id },
        data: {
          imageUrlThumbnail: blobUrls.blobThumbnail,
          imageUrlFHD: blobUrls.blobFhd,
          imageUrl4K: blobUrls.blob4k
        }
      });

      // The images go within the transaction, as it uploaded them.
      if (healthcheck) {
        await this.deleteScreenshotRecords(updatedScreenshot.id, prisma);
        await this.screenshotStorage.deleteScreenshots(updatedScreenshot);
      }

      return updatedScreenshot;
    }
  }

  /**
   * Updates a screenshot with the specified data.
   * Once the update is committed, runs in the background the translation of a changed city name,
   * and the mods cache warmup for a newly showcased mod.
   *
   * @param screenshotId The unique identifier of the screenshot to update.
   * @param data The data to update the screenshot with.
   *
   * @returns A promise that resolves to the updated screenshot object.
   */
  public async updateScreenshot(
    screenshotId: Screenshot['id'],
    data: Pick<
      Prisma.ScreenshotUpdateInput,
      'cityName' | 'showcasedModId' | 'description' | 'shareParadoxModIds' | 'shareRenderSettings'
    >
  ): Promise<Screenshot> {
    const update = await this.prisma.$transaction(transaction);
    const updatedScreenshot = update.screenshot;

    // After the commit, so a rollback starts no work and a slow Paradox API holds no transaction.
    if (update.isShowcasedModAdded) {
      this.backgroundTasks.run(
        oneLine`
        Failed to warmup mods cache for screenshot "${updatedScreenshot.cityName}"
        (#${updatedScreenshot.id}).`,
        () => this.modService.getMod(nn(updatedScreenshot.showcasedModId) as ParadoxModId)
      );
    }

    if (update.needsTranslation) {
      this.backgroundTasks.run(
        `Failed to translate city name "${updatedScreenshot.cityName}" (#${updatedScreenshot.id}).`,
        () => this.updateCityNameTranslation(updatedScreenshot)
      );
    }

    return updatedScreenshot;

    async function transaction(tx: Prisma.TransactionClient): Promise<{
      screenshot: Screenshot;
      needsTranslation: boolean;
      isShowcasedModAdded: boolean;
    }> {
      try {
        const originalScreenshot = await tx.screenshot.findUniqueOrThrow({
          where: { id: screenshotId }
        });

        const needsTranslation =
          data.cityName != Prisma.skip && originalScreenshot.cityName != data.cityName;

        const screenshot = await tx.screenshot.update({
          where: { id: screenshotId },
          data: {
            ...data,
            // Never cleared here: a translation still pending from before stays pending.
            needsTranslation: needsTranslation ? true : Prisma.skip,
            cityNameLocale: needsTranslation ? null : Prisma.skip,
            cityNameLatinized: needsTranslation ? null : Prisma.skip,
            cityNameTranslated: needsTranslation ? null : Prisma.skip,
            // A newly showcased mod awaits moderation, an unchanged one keeps its outcome.
            isShowcasedModValidated:
              data.showcasedModId == Prisma.skip ||
              data.showcasedModId == originalScreenshot.showcasedModId
                ? Prisma.skip
                : false
          }
        });

        return {
          screenshot,
          needsTranslation,
          isShowcasedModAdded:
            screenshot.showcasedModId != null &&
            screenshot.showcasedModId != originalScreenshot.showcasedModId
        };
      } catch (error) {
        if (isPrismaError(error) && error.code == 'P2025') {
          throw new NotFoundByIdError(screenshotId, { cause: error });
        }

        throw error;
      }
    }
  }

  /**
   * Deletes a screenshot and its embedding, then its stored images once the deletion is
   * committed, so a failed deletion keeps them.
   *
   * @returns A promise that resolves to the deleted screenshot record.
   */
  public async deleteScreenshot(screenshotId: Screenshot['id']): Promise<Screenshot> {
    const screenshot = await this.prisma.$transaction(tx =>
      this.deleteScreenshotRecords(screenshotId, tx)
    );

    this.deleteScreenshotImages(screenshot);

    return screenshot;
  }

  /**
   * Deletes the stored images of a screenshot whose deletion is committed, in the background.
   * A failure is logged and reported, leaving orphaned images, as the deletion itself stands.
   */
  public deleteScreenshotImages(screenshot: Screenshot): void {
    this.backgroundTasks.run(
      `Failed to delete the images of screenshot #${screenshot.id} "${screenshot.cityName}".`,
      () => this.screenshotStorage.deleteScreenshots(screenshot)
    );
  }

  /**
   * Deletes a screenshot and its embedding within the caller's transaction, leaving its stored
   * images.
   * The caller deletes them with {@link deleteScreenshotImages} once the transaction is
   * committed, so a rollback keeps them.
   *
   * @returns A promise that resolves to the deleted screenshot record.
   */
  public async deleteScreenshotRecords(
    screenshotId: Screenshot['id'],
    tx: Prisma.TransactionClient
  ): Promise<Screenshot> {
    try {
      // Embeddings require special cleanup (ex. index removal), so we do not rely on the Prisma
      // relation.
      await this.screenshotSimilarityDetector.deleteEmbedding(screenshotId, tx);

      const screenshot = await tx.screenshot.delete({
        where: { id: screenshotId }
      });

      this.logger.log(`Deleted screenshot #${screenshot.id} "${screenshot.cityName}".`);

      return screenshot;
    } catch (error) {
      if (isPrismaError(error) && error.code == 'P2025') {
        throw new NotFoundByIdError(screenshotId, { cause: error });
      }

      throw error;
    }
  }

  /**
   * Marks a screenshot as reported by a user.
   *
   * @param screenshotId Screenshot to mark as reported.
   * @param reportedById The Creator OID of the user who made the report.
   *   Useful to reset a bunch of reports if the report feature is abused.
   */
  public async markReported(
    screenshotId: Screenshot['id'],
    reportedById: Creator['id']
  ): Promise<Screenshot> {
    const screenshot = await this.prisma.screenshot.findUnique({
      where: { id: screenshotId },
      select: {
        isApproved: true,
        cityName: true,
        creator: { select: { creatorName: true } }
      }
    });

    if (!screenshot) {
      throw new NotFoundByIdError(screenshotId);
    }

    if (screenshot.isApproved) {
      throw new ScreenshotApprovedError(screenshot, config.supportContact);
    }

    try {
      return await this.prisma.screenshot.update({
        where: { id: screenshotId },
        data: { isReported: true, reportedById },
        include: { creator: true }
      });
    } catch (error) {
      if (isPrismaError(error) && error.code == 'P2025') {
        throw new NotFoundByIdError(screenshotId, { cause: error });
      }

      throw error;
    }
  }

  /**
   * Unmarks a screenshot as reported by a user.
   */
  public async unmarkReported(screenshotId: Screenshot['id']): Promise<Screenshot> {
    try {
      return await this.prisma.screenshot.update({
        where: { id: screenshotId },
        data: {
          isApproved: true,
          isReported: false,
          reportedById: null
        },
        include: { creator: true }
      });
    } catch (error) {
      if (isPrismaError(error) && error.code == 'P2025') {
        throw new NotFoundByIdError(screenshotId, { cause: error });
      }

      throw error;
    }
  }

  /**
   * Update of the transliteration and translation of the city name for the given screenshot,
   * ignoring {@link Screenshot.needsTranslation}.
   * Skips screenshots with city names that are not eligible to transliteration/translation (see
   * {@link AiTranslatorService.isEligibleForTranslation}).
   * If another screenshot with the same city name is found that was already translated, its values
   * are reused. This serves both the purpose of saving on OpenAI requests but most importantly,
   * makes sure we have a stable translation for different uploads of the same city.
   * A screenshot renamed meanwhile is left to the translation its rename started, and counts as
   * not translated.
   */
  public async updateCityNameTranslation(
    screenshot: Pick<Screenshot, 'id' | 'creatorId' | 'cityName'>
  ): Promise<
    { translated: false } | { translated: true; cached: boolean; screenshot: Screenshot }
  > {
    // Matching the city name too, see the final update.
    const where = { id: screenshot.id, cityName: screenshot.cityName };

    // If no translation is needed, mark the screenshot as not needing translation.
    if (!AiTranslatorService.isEligibleForTranslation(screenshot.cityName)) {
      await this.prisma.screenshot.updateMany({ where, data: { needsTranslation: false } });

      return { translated: false };
    }

    // Attempt to find a screenshot with the same city name that was already translated.
    const screenshotWithSameName = await this.prisma.screenshot.findFirst({
      where: {
        needsTranslation: false,
        cityName: screenshot.cityName
      },
      select: { cityNameLocale: true, cityNameLatinized: true, cityNameTranslated: true }
    });

    let cached: boolean;
    let updateInput: Prisma.ScreenshotUpdateInput;

    // If a screenshot with the same city name was found, reuse its values.
    if (screenshotWithSameName?.cityNameLocale) {
      cached = true;

      updateInput = {
        needsTranslation: false,
        cityNameLocale: screenshotWithSameName.cityNameLocale,
        cityNameLatinized: screenshotWithSameName.cityNameLatinized,
        cityNameTranslated: screenshotWithSameName.cityNameTranslated
      };
    }
    // Otherwise, call the AI translator to translate the city name.
    else {
      cached = false;

      const result = await this.aiTranslator.translateCityName({
        creatorId: screenshot.creatorId,
        input: screenshot.cityName
      });

      updateInput = {
        needsTranslation: false,
        cityNameLocale: result.twoLetterLocaleCode,
        cityNameLatinized: result.transliteration,
        cityNameTranslated: result.translation
      };
    }

    // Update the screenshot with the new values, unless it was renamed while this translation ran:
    // the rename's own translation may already have written its values.
    try {
      const updatedScreenshot = await this.prisma.screenshot.update({ where, data: updateInput });

      return { translated: true, cached, screenshot: updatedScreenshot };
    } catch (error) {
      if (isPrismaError(error) && error.code == 'P2025') {
        return { translated: false };
      }

      throw error;
    }
  }

  /**
   * Retrieves a random screenshot from the Hall of Fame, with weights to assign probabilities to
   * select the algorithm used to find a screenshot ({@link RandomScreenshotAlgorithm}),
   * algorithms with a higher weight have a higher probability of being selected.
   *
   * If no screenshot is found by the algorithm that was randomly selected, it falls back to
   * {@link getScreenshotRandom}.
   */
  public async getWeightedRandomScreenshot(
    weights: RandomScreenshotWeights,
    creatorId: Maybe<Creator['id']>,
    alreadyViewedMaxAgeInDays: number | undefined
  ): Promise<ScreenshotWithAlgo> {
    // Get the IDs of the screenshots viewed by the user to avoid showing them screenshots they
    // have already seen.
    const viewedIds = creatorId
      ? await this.viewService.getViewedScreenshotIds(creatorId, alreadyViewedMaxAgeInDays)
      : new Set<string>();

    const viewedOids: readonly JsonOid[] = Array.from(viewedIds).map(id => ({ $oid: id }));

    this.logger.verbose(
      oneLine`
      Attempt to find screenshot starting
      (creator id: ${creatorId ? `#${creatorId}` : 'anon'}, viewed ids: ${viewedIds.size}).`
    );

    // Try to get a screenshot using the weighted random selection and taking into account the
    // viewed screenshots.
    let screenshot = await this.tryGetWeightedRandomScreenshot(weights, viewedOids);

    // If we still did not find a screenshot, fall back to a completely random screenshot.
    if (!screenshot) {
      this.logger.verbose(`No screenshot found, falling back to random.`);

      const random = await this.getScreenshotRandom([]);

      if (random) {
        screenshot = { ...random, __algorithm: 'random_default' };
      }
    }

    // At this point we have a screenshot or the database is empty.
    assert.ok(screenshot, `Not a single screenshot found. Empty database?`);

    this.logger.verbose(
      // oxlint-disable-next-line no-underscore-dangle
      `We have a screenshot! (id: #${screenshot.id}, algo: ${screenshot.__algorithm})`
    );

    return screenshot;
  }

  /**
   * Serializes a {@link Screenshot} to a JSON object for API responses.
   */
  public serialize(
    screenshot: Screenshot & {
      // Undefined if relation not loaded.
      creator?: Creator | undefined;
      // Undefined if relation not loaded.
      favorites?: Favorite[] | undefined;
      // Undefined if relation not loaded.
      views?: View[] | undefined;
      // Semantics for showcasedMod: undefined = not loaded, null = loaded but empty
      showcasedMod?: Mod | undefined | null;
    },
    req: FastifyRequest
  ): JsonObject {
    const viewer = req[CreatorAuthenticationService.authenticatedCreatorKey];

    const dfnsLocale = this.dateFnsLocalization.getLocaleForRequest(req);

    const createdAtAdjusted = this.dateFnsLocalization.applyTimezoneOffsetOnDateForRequest(
      req,
      screenshot.createdAt
    );

    // The render conditions follow the render settings' share choice.
    const isRenderSettingsVisible =
      viewer?.id == screenshot.creatorId || screenshot.shareRenderSettings;

    return {
      id: screenshot.id,
      isApproved: screenshot.isApproved,
      isReported: screenshot.isReported,
      favoritesCount: screenshot.favoritesCount,
      favoritingPercentage: screenshot.favoritingPercentage,
      viewsCount: screenshot.viewsCount,
      uniqueViewsCount: screenshot.uniqueViewsCount,
      viewerUrl: `${config.http.baseUrl}/api/v1/screenshots/${screenshot.id}/viewer`,
      viewerClicksCount: screenshot.viewerClicksCount,
      cityName: screenshot.cityName,
      cityNameLocale: screenshot.cityNameLocale,
      cityNameLatinized: screenshot.cityNameLatinized,
      cityNameTranslated: screenshot.cityNameTranslated,
      cityMilestone: screenshot.cityMilestone,
      cityPopulation: screenshot.cityPopulation,
      mapName: screenshot.mapName,
      description: screenshot.description,
      imageUrlThumbnail: this.screenshotStorage.getScreenshotUrl(screenshot.imageUrlThumbnail),
      imageUrlFHD: this.screenshotStorage.getScreenshotUrl(screenshot.imageUrlFHD),
      imageUrl4K: this.screenshotStorage.getScreenshotUrl(screenshot.imageUrl4K),
      shareParadoxModIds: screenshot.shareParadoxModIds,
      paradoxModIds:
        viewer?.id == screenshot.creatorId || screenshot.shareParadoxModIds
          ? screenshot.paradoxModIds
          : [],
      shareRenderSettings: screenshot.shareRenderSettings,
      renderSettings: isRenderSettingsVisible ? (screenshot.renderSettings as JsonObject) : {},
      renderConditions: isRenderSettingsVisible ? (screenshot.renderConditions as JsonObject) : {},
      capabilities: Object.entries(ScreenshotService.capabilitiesSince)
        .filter(([, since]) => screenshot.createdAt >= since)
        .map(([field]) => field),
      createdAt: screenshot.createdAt.toISOString(),
      createdAtFormatted: dfns.format(createdAtAdjusted, 'Pp', {
        locale: dfnsLocale
      }),
      createdAtFormattedDistance: dfns.formatDistanceToNow(
        // Not a mistake, do not use createdAtAdjusted here, we calculate the difference
        // between two UTC dates.
        screenshot.createdAt,
        { locale: dfnsLocale, addSuffix: true }
      ),
      creatorId: screenshot.creatorId,
      creator: optionallySerialized(
        screenshot.creator && this.creatorService.serialize(screenshot.creator)
      ),
      showcasedModId: screenshot.showcasedModId,
      showcasedMod:
        screenshot.showcasedMod === undefined
          ? // oxlint-disable-next-line unicorn/no-useless-undefined - required
            optionallySerialized(undefined)
          : screenshot.showcasedMod
            ? this.modService.serialize(screenshot.showcasedMod, dfnsLocale)
            : null,
      favorites: optionallySerialized(
        screenshot.favorites?.map(favorite => this.favoriteService.serialize(favorite))
      ),
      views: optionallySerialized(screenshot.views?.map(view => this.viewService.serialize(view)))
    };
  }

  /**
   * Calculates the favoriting percentage threshold for determining popular screenshots
   * based on a specified percentile ({@link config.screenshots.popularScreenshotsPercentile}) and
   * a minimum favorites count ({@link config.screenshots.popularScreenshotsMinFavorites}).
   */
  private async getPopularFavoritingPercentageThreshold(): Promise<number> {
    const [result] = (await this.prisma.screenshot.aggregateRaw({
      pipeline: [
        {
          $match: {
            favoritesCount: { $gte: config.screenshots.popularScreenshotsMinFavorites }
          }
        },
        {
          $group: {
            _id: null,
            // oxlint-disable-next-line id-length
            p: {
              $percentile: {
                input: '$favoritingPercentage',
                // oxlint-disable-next-line id-length
                p: [config.screenshots.popularScreenshotsPercentile],
                method: 'approximate'
              }
            }
          }
        },
        { $project: { median: { $arrayElemAt: ['$p', 0] } } }
      ]
    })) as unknown as ReadonlyArray<{ median: number }>;

    // No result if there is no match (empty or new database).
    return result?.median ?? 0;
  }

  /**
   * Used by {@link getWeightedRandomScreenshot}, see {@link pickWeightedAlgorithm}.
   */
  private async tryGetWeightedRandomScreenshot(
    weights: RandomScreenshotWeights,
    viewedIds: readonly JsonOid[]
  ): Promise<ScreenshotWithAlgo | undefined> {
    const pick = await pickWeightedAlgorithm(
      weights,
      algorithm => {
        this.logger.debug(`Try screenshot selection algorithm: ${algorithm}`);

        return this.randomScreenshotFunctions[algorithm](viewedIds);
      },
      Math.random
    );

    return pick && { ...pick.result, __algorithm: pick.algorithm };
  }

  /**
   * Checks if a user has uploaded too many screenshots in the last 24 hours.
   * A user is identified by their creator ID, hardware IDs, or IPs, meaning two Creator IDs
   * sharing a hardware ID or an IP will share the same quota.
   *
   * @throws {ScreenshotRateLimitExceededError} If the limit is reached.
   */
  private async checkUploadLimit(creator: Pick<Creator, 'id' | 'ips' | 'hwids'>): Promise<void> {
    // Let's find out by retrieving the screenshots uploaded in the last 24 hours, oldest first,
    // so if the limit is reached, we can check based on the date when the next screenshot can
    // be uploaded.
    const latestScreenshots = await this.prisma.screenshot.findMany({
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
      // Enough to tell whether the limit is reached, as many players can share an IP.
      take: config.screenshots.limitPer24h,
      where: {
        OR: uniqueUserConditions(creator),
        createdAt: { gt: dfns.subDays(new Date(), 1) }
      }
    });

    // If the limit is reached, throw the error.
    if (latestScreenshots.length >= config.screenshots.limitPer24h) {
      throw new ScreenshotRateLimitExceededError(
        config.screenshots.limitPer24h,
        dfns.addDays(nn(latestScreenshots[0]).createdAt, 1)
      );
    }
  }

  /**
   * Retrieves a completely random screenshot.
   */
  private getScreenshotRandom(nin: readonly JsonOid[]): Promise<ScreenshotWithCreator | null> {
    return this.runAggregateForSingleScreenshot([
      {
        $match: {
          _id: { $nin: nin },
          isReported: false
        }
      },
      { $sample: { size: 1 } }
    ]);
  }

  /**
   * Retrieves a screenshot that has a high favoriting percentage:
   * - ≥ 10 favorites
   * - ≥ X% favoriting percentage (X being dynamically determined, see
   * {@link getPopularFavoritingPercentageThreshold})
   */
  private getScreenshotPopular(nin: readonly JsonOid[]): Promise<ScreenshotWithCreator | null> {
    // Uses [isReported, favoritesCount, favoritingPercentage] compound index for matching, test
    // changes to ensure index usage.
    return this.runAggregateForSingleScreenshot([
      {
        $match: {
          _id: { $nin: nin },
          isReported: false,
          favoritesCount: { $gte: config.screenshots.popularScreenshotsMinFavorites },
          favoritingPercentage: { $gte: this.popularScreenshotsFavoritingPercentageThreshold }
        }
      },
      { $sample: { size: 1 } }
    ]);
  }

  /**
   * Retrieves a screenshot that has one of the highest favoriting percentage:
   * - ≥ 1% favoriting percentage (this is mostly an optimization pass to reduce the set).
   * - Sorts by favoriting percentage descending.
   * - Limits to the X best.
   * - Takes one random screenshot in that pool.
   */
  private getScreenshotTrending(nin: readonly JsonOid[]): Promise<ScreenshotWithCreator | null> {
    // Uses [isReported, favoritingPercentage] compound index for sorting with limiting and
    // filtering, test changes to ensure index usage.
    return this.runAggregateForSingleScreenshot([
      {
        $match: {
          _id: { $nin: nin },
          isReported: false,
          favoritingPercentage: { $gt: 1 }
        }
      },
      { $sort: { favoritingPercentage: -1 } },
      { $limit: ScreenshotService.sampleSizeForDeterministicAlgorithms },
      { $sample: { size: 1 } }
    ]);
  }

  /**
   * Retrieves a screenshot uploaded between X days ago (configurable in env) and now:
   * - Matches screenshots posted within the time window.
   * - Sorts by views count ascending so that the least viewed screenshots are prioritized.
   * - Limits to the X most recent, least viewed.
   * - Takes one random screenshot in that pool.
   */
  private getScreenshotRecent(nin: readonly JsonOid[]): Promise<ScreenshotWithCreator | null> {
    const $date = dfns.subDays(new Date(), config.screenshots.recencyThresholdDays);

    // Uses [isReported, createdAt] compound index for sorting with limiting and filtering when
    // there is less than sampleSize results, and [isReported, viewsCount, createdAt] when there are
    // more than sampleSize results, test changes to ensure index usage.
    return this.runAggregateForSingleScreenshot([
      {
        $match: {
          _id: { $nin: nin },
          isReported: false,
          createdAt: { $gt: { $date } }
        }
      },
      { $sort: { viewsCount: 1, createdAt: 1 } },
      { $limit: ScreenshotService.sampleSizeForDeterministicAlgorithms },
      { $sample: { size: 1 } }
    ]);
  }

  /**
   * Retrieves a screenshot among the ones that have the fewest views:
   * - Omits recent screenshots (see {@link getScreenshotRecent}) because they also have few views.
   * - Sorts by views count ascending so that the least viewed screenshots are prioritized.
   * - Limits to the X most ancient, least viewed.
   * - Takes one random screenshot in that pool.
   */
  private getScreenshotArcheologist(
    nin: readonly JsonOid[]
  ): Promise<ScreenshotWithCreator | null> {
    const $date = dfns.subDays(new Date(), config.screenshots.recencyThresholdDays);

    // Uses [isReported, viewsCount, createdAt] compound index for sorting with limiting and
    // filtering, test changes to ensure index usage.
    return this.runAggregateForSingleScreenshot([
      {
        $match: {
          _id: { $nin: nin },
          isReported: false,
          createdAt: { $lt: { $date } }
        }
      },
      { $sort: { viewsCount: 1, createdAt: 1 } },
      { $limit: ScreenshotService.sampleSizeForDeterministicAlgorithms },
      { $sample: { size: 1 } }
    ]);
  }

  /**
   * Retrieves a screenshot made by a supporter:
   * - Finds a random supporter.
   * - Matches screenshots posted by that supporter.
   * - Sorts by views count ascending so that the least viewed screenshots are prioritized.
   * - Sorts by upload date ascending so that the oldest screenshots are prioritized.
   * - Takes one random screenshot in that pool.
   */
  private async getScreenshotSupporter(
    nin: readonly JsonOid[]
  ): Promise<ScreenshotWithCreator | null> {
    const supporters = await this.prisma.creator.aggregateRaw({
      pipeline: [
        { $match: { isSupporter: true } },
        { $sample: { size: 1 } },
        { $project: { _id: true } }
      ]
    });

    assert.ok(Array.isArray(supporters), `Expected an array of 0..1 results.`);

    const supporter = supporters[0] as JsonObject;
    if (!supporter?._id) {
      return null;
    }

    return this.runAggregateForSingleScreenshot([
      {
        $match: {
          _id: { $nin: nin },
          isReported: false,
          creatorId: supporter._id
        }
      },
      { $sort: { viewsCount: 1, createdAt: 1 } },
      { $limit: 1 }
    ]);
  }

  /**
   * Runs an aggregate pipeline that selects a single screenshot, for use by
   * {@link randomScreenshotFunctions} functions.
   * Loads it with its creator through Prisma rather than from the raw document, which lacks the
   * fields the document never had, where Prisma reads them as null.
   */
  private async runAggregateForSingleScreenshot(
    pipeline: Prisma.InputJsonValue[]
  ): Promise<ScreenshotWithCreator | null> {
    const results = await this.prisma.screenshot.aggregateRaw({
      pipeline: [...pipeline, { $project: { _id: true } }]
    });

    assert.ok(Array.isArray(results), `Expected an array of 0..1 results.`);

    const id = ((results[0] as JsonObject | undefined)?._id as JsonObject | undefined)?.$oid;

    if (typeof id != 'string') {
      return null;
    }

    // Null if deleted in between, as if the algorithm found nothing.
    return this.prisma.screenshot.findUnique({ where: { id }, include: { creator: true } });
  }
}

/**
 * Given a set of weights for each algorithm:
 * - Selects an algorithm based on the weights.
 * - Tries to get a result using the selected algorithm.
 * - If the selected algorithm returns nothing, removes it from the candidate algorithms so it is
 * not selected again.
 * - Repeats the process until a result is found or all algorithms have been tried.
 *
 * @param weights Positive integers or zero, totaling a safe integer, or the pick may never end.
 * @param random Random source returning a number in [0, 1), like `Math.random`.
 */
export async function pickWeightedAlgorithm<TAlgorithm extends string, TResult>(
  weights: Readonly<Record<TAlgorithm, number>>,
  runAlgorithm: (algorithm: TAlgorithm) => Promise<TResult | null>,
  random: () => number
): Promise<{ algorithm: TAlgorithm; result: TResult } | undefined> {
  // Get a mutable copy of the weights.
  const currentWeights: Record<TAlgorithm, number> = { ...weights };

  // Loop until we find a result or all algorithms have been tried, at which point it returns
  // undefined.
  while (true) {
    // Get the total weight of the remaining algorithms.
    const totalWeight = Object.values<number>(currentWeights).reduce(
      (total, weight) => total + weight,
      0
    );

    // If the total weight is 0, we have tried all algorithms, bail out.
    if (totalWeight == 0) {
      return undefined;
    }

    // Get a random number between 0 and the total weight.
    // This number will evolve as we iterate through the algorithms until we find one that has a
    // weight higher than the random number.
    // This is a weighted random selection, a classic algorithm.
    let roll = random() * totalWeight;

    // Algorithm-to-weight pairs to iterate through.
    const algoWeightsKeyPairs = Object.entries(currentWeights) as Array<[TAlgorithm, number]>;

    // Iterate through the algorithms and their weights until we find a winner for the running
    // random number.
    // Remember: this loop does not iterate through algorithms to call each one until a result is
    // found, it just selects a random algorithm; the former is the role of the outer loop.
    for (const [algorithm, weight] of algoWeightsKeyPairs) {
      // If the random number is higher than the weight of the current algorithm, subtract the
      // weight from the random number and try the next algorithm.
      if (roll >= weight) {
        roll -= weight;
        continue;
      }

      // We found a winner, try to get a result!
      // oxlint-disable-next-line no-await-in-loop - sequential by design: one weighted-random algorithm is tried per iteration, only trying another if the previous found nothing
      const result = await runAlgorithm(algorithm);

      // If we found a result, return it with the algorithm name.
      if (result != null) {
        return { algorithm, result };
      }

      // If we didn't find a result, set the algorithm's weight to 0 so it is not tried again.
      currentWeights[algorithm] = 0;

      // Break the for loop, we tried this algorithm. The outer loop will pick again among the
      // remaining ones, if there are any left.
      break;
    }
  }
}

export abstract class ScreenshotError extends StandardError {}

export class ScreenshotApprovedError extends ScreenshotError {
  public override httpErrorType = ForbiddenException;

  public readonly screenshot: Pick<Screenshot, 'cityName'> & {
    creator: Pick<Creator, 'creatorName'>;
  };

  public readonly supportContact: string;

  public constructor(
    screenshot: ScreenshotApprovedError['screenshot'],
    supportContact: string,
    options?: ErrorOptions
  ) {
    super(
      oneLine`
      Screenshot "${screenshot.cityName}" by ${screenshot.creator.creatorName} has already been
      approved manually by an administrator, and hence can't be reported.
      If you think this is a mistake, please contact support (${supportContact}).`,
      options
    );

    this.supportContact = supportContact;
    this.screenshot = screenshot;
  }
}

export class ScreenshotRateLimitExceededError extends ScreenshotError {
  public override httpErrorType = ForbiddenException;

  public readonly limit: number;

  public readonly notBefore: Date;

  public constructor(limit: number, notBefore: Date) {
    super(
      oneLine`
      You can only upload a maximum of ${limit} screenshots every 24 hours.
      Your next slot will not open before ${notBefore.toLocaleString()} UTC.`
    );

    this.notBefore = notBefore;
    this.limit = limit;
  }
}
