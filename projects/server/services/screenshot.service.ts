import assert from 'node:assert/strict';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Creator, Favorite, Prisma, Screenshot, View } from '@prisma/client';
import * as sentry from '@sentry/bun';
import { oneLine } from 'common-tags';
import * as dfns from 'date-fns';
import type { FastifyRequest } from 'fastify';
import { filesize } from 'filesize';
import { nn } from '../../shared/utils';
import {
  isPrismaError,
  type JsonObject,
  type Maybe,
  NotFoundByIdError,
  optionallySerialized,
  type ParadoxModId,
  StandardError
} from '../common';
import { config } from '../config';
import { AiTranslatorService } from './ai-translator.service';
import { CreatorService } from './creator.service';
import { DateFnsLocalizationService } from './date-fns-localization.service';
import { FavoriteService } from './favorite.service';
import { PrismaService } from './prisma.service';
import { ScreenshotProcessingService } from './screenshot-processing.service';
import { ScreenshotSimilarityDetectorService } from './screenshot-similarity-detector.service';
import { ScreenshotStorageService } from './screenshot-storage.service';
import { ViewService } from './view.service';

type RandomScreenshotAlgorithm = 'random' | 'trending' | 'recent' | 'archeologist' | 'supporter';

type RandomScreenshotWeights = Readonly<Record<RandomScreenshotAlgorithm, number>>;

type RandomScreenshotFunctions = Readonly<
  Record<RandomScreenshotAlgorithm, (nin: readonly JsonOid[]) => Promise<Screenshot | null>>
>;

type ScreenshotWithAlgo = Screenshot & {
  __algorithm: RandomScreenshotAlgorithm | 'random_default';
};

interface JsonOid extends Prisma.InputJsonObject {
  readonly $oid: string;
}

@Injectable()
export class ScreenshotService {
  private static readonly sampleSizeForDeterministicAlgorithms = 100;

  /**
   * Timeout after which the upload process and database transaction are canceled.
   */
  private static readonly ingestScreenshotTransactionTimeout = 60_000;

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(DateFnsLocalizationService)
  private readonly dateFnsLocalization!: DateFnsLocalizationService;

  @Inject(AiTranslatorService)
  private readonly aiTranslator!: AiTranslatorService;

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
    trending: this.getScreenshotTrending.bind(this),
    recent: this.getScreenshotRecent.bind(this),
    archeologist: this.getScreenshotArcheologist.bind(this),
    supporter: this.getScreenshotSupporter.bind(this)
  };

  /**
   * Ingests a screenshot and its metadata into the Hall of Fame.
   *
   * By ingesting a screenshot, we mean:
   * - Resizing the screenshot to two sizes.
   * - Uploading the screenshots to Azure Blob Storage.
   * - Creating a {@link Screenshot} record in the database.
   */
  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: easier to follow that way, intricate code.
  public async ingestScreenshot({
    healthcheck,
    ...data
  }: {
    creator: Pick<Creator, 'id' | 'creatorName' | 'creatorNameSlug' | 'hwids' | 'ips'>;
    cityName: string;
    cityMilestone: number;
    cityPopulation: number;
    paradoxModIds: ReadonlySet<ParadoxModId>;
    renderSettings: Record<string, number>;
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
      // Translate city name asynchronously.
      this.updateCityNameTranslation(screenshot).catch(error => {
        this.logger.error(
          `Failed to translate city name "${screenshot.cityName}" (#${screenshot.id}).`,
          error
        );

        sentry.captureException(error);
      });

      // Infer embeddings asynchronously.
      this.screenshotSimilarityDetector
        .batchUpdateEmbeddings(screenshot.id, [
          { id: screenshot.id, imageUrlOrBuffer: imageFhdBuffer }
        ])
        .catch(error => {
          this.logger.error(
            `Failed to infer embeddings for screenshot "${screenshot.cityName}" (#${screenshot.id}).`
          );

          sentry.captureException(error);
        });
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
          imageUrlThumbnail: '',
          imageUrlFHD: '',
          imageUrl4K: '',
          paradoxModIds: Array.from(data.paradoxModIds),
          renderSettings: data.renderSettings,
          metadata: data.metadata,
          isReported: healthcheck // make sure health check uploads are never shown
        }
      });

      // Upload the screenshots.
      const blobUrls = await this.screenshotStorage.uploadScreenshots(
        data.creator,
        screenshotWithoutBlobs,
        imageThumbnailBuffer,
        imageFhdBuffer,
        image4kBuffer
      );

      // Update the screenshot with the blob URLs.
      const updatedScreenshot = await prisma.screenshot.update({
        where: { id: screenshotWithoutBlobs.id },
        data: {
          imageUrlThumbnail: blobUrls.blobThumbnail,
          imageUrlFHD: blobUrls.blobFhd,
          imageUrl4K: blobUrls.blob4k
        }
      });

      if (healthcheck) {
        await this.deleteScreenshot(updatedScreenshot.id, prisma);
      }

      return updatedScreenshot;
    }
  }

  public deleteScreenshot(
    screenshotId: Screenshot['id'],
    prisma?: Prisma.TransactionClient
  ): Promise<Screenshot> {
    return prisma
      ? transaction.call(this, prisma)
      : this.prisma.$transaction(transaction.bind(this));

    async function transaction(
      this: ScreenshotService,
      tx: Prisma.TransactionClient
    ): Promise<Screenshot> {
      try {
        await this.screenshotSimilarityDetector.deleteEmbedding(screenshotId, tx);

        const screenshot = await tx.screenshot.delete({
          where: { id: screenshotId }
        });

        await this.screenshotStorage.deleteScreenshots(screenshot);

        this.logger.log(`Deleted screenshot #${screenshot.id} "${screenshot.cityName}".`);

        return screenshot;
      } catch (error) {
        if (isPrismaError(error) && error.code == 'P2025') {
          throw new NotFoundByIdError(screenshotId, { cause: error });
        }

        throw error;
      }
    }
  }

  /**
   * Marks a screenshot as reported by a user.
   *
   * @param screenshotId Screenshot to mark as reported.
   * @param reportedById The Creator OID of the user who made the report.
   *                     Useful to reset a bunch of reports if the report feature is abused.
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
   */
  public async updateCityNameTranslation(
    screenshot: Pick<Screenshot, 'id' | 'creatorId' | 'cityName'>
  ): Promise<
    { translated: false } | { translated: true; cached: boolean; screenshot: Screenshot }
  > {
    // If no translation is needed, mark the screenshot as not needing translation.
    if (!AiTranslatorService.isEligibleForTranslation(screenshot.cityName)) {
      await this.prisma.screenshot.update({
        where: { id: screenshot.id },
        data: { needsTranslation: false }
      });

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

    // Update the screenshot with the new values.
    const updatedScreenshot = await this.prisma.screenshot.update({
      where: { id: screenshot.id },
      data: updateInput
    });

    return { translated: true, cached, screenshot: updatedScreenshot };
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
    assert(screenshot, `Not a single screenshot found. Empty database?`);

    this.logger.verbose(
      `We have a screenshot! (id: #${screenshot.id}, algo: ${screenshot.__algorithm})`
    );

    return screenshot;
  }

  /**
   * Serializes a {@link Screenshot} to a JSON object for API responses.
   */
  public serialize(
    screenshot: Screenshot & {
      creator?: Creator;
      favorites?: Favorite[];
      views?: View[];
    },
    req: FastifyRequest
  ): JsonObject {
    const dfnsLocale = this.dateFnsLocalization.getLocaleForRequest(req);

    const createdAtAdjusted = this.dateFnsLocalization.applyTimezoneOffsetOnDateForRequest(
      req,
      screenshot.createdAt
    );

    return {
      id: screenshot.id,
      isApproved: screenshot.isApproved,
      isReported: screenshot.isReported,
      favoritesCount: screenshot.favoritesCount,
      favoritingPercentage: screenshot.favoritingPercentage,
      viewsCount: screenshot.viewsCount,
      uniqueViewsCount: screenshot.uniqueViewsCount,
      cityName: screenshot.cityName,
      cityNameLocale: screenshot.cityNameLocale,
      cityNameLatinized: screenshot.cityNameLatinized,
      cityNameTranslated: screenshot.cityNameTranslated,
      cityMilestone: screenshot.cityMilestone,
      cityPopulation: screenshot.cityPopulation,
      imageUrlThumbnail: this.screenshotStorage.getScreenshotUrl(screenshot.imageUrlThumbnail),
      imageUrlFHD: this.screenshotStorage.getScreenshotUrl(screenshot.imageUrlFHD),
      imageUrl4K: this.screenshotStorage.getScreenshotUrl(screenshot.imageUrl4K),
      paradoxModIds: screenshot.paradoxModIds,
      renderSettings: screenshot.renderSettings as JsonObject,
      createdAt: screenshot.createdAt.toISOString(),
      createdAtFormatted: dfns.format(createdAtAdjusted, 'Pp', {
        locale: dfnsLocale
      }),
      createdAtFormattedDistance: dfns.formatDistanceToNowStrict(
        // Not a mistake, do not use createdAtAdjusted here, we calculate the difference
        // between two UTC dates.
        screenshot.createdAt,
        { locale: dfnsLocale, addSuffix: true }
      ),
      creatorId: screenshot.creatorId,
      creator: optionallySerialized(
        screenshot.creator && this.creatorService.serialize(screenshot.creator)
      ),
      favorites: optionallySerialized(
        screenshot.favorites?.map(favorite => this.favoriteService.serialize(favorite))
      ),
      views: optionallySerialized(screenshot.views?.map(view => this.viewService.serialize(view)))
    };
  }

  /**
   * Used by {@link getWeightedRandomScreenshot}.
   *
   * Given a set of weights for each algorithm:
   *  - Selects an algorithm based on the weights.
   *  - Tries to get a screenshot using the selected algorithm.
   *  - If no screenshot is found using the selected algorithm, removes it from the candidate
   *    algorithms so it is not selected again.
   *  - Repeats the process until a screenshot is found or all algorithms have been tried.
   */
  private async tryGetWeightedRandomScreenshot(
    weights: RandomScreenshotWeights,
    viewedIds: readonly JsonOid[]
  ): Promise<ScreenshotWithAlgo | undefined> {
    // Get a mutable copy of the weights.
    const currentWeights = { ...weights };

    // Loop until we find a screenshot or all algorithms have been tried, at which point it
    // returns undefined.
    while (true) {
      // Get the total weight of the remaining algorithms.
      const totalWeight = Object.values(currentWeights).reduce(
        (total, weight) => total + weight,
        0
      );

      // If the total weight is 0, we have tried all algorithms, bail out.
      if (totalWeight == 0) {
        return;
      }

      // Get a random number between 0 and the total weight.
      // This number will evolve as we iterate through the algorithms until we find one that
      // has a weight higher than the random number.
      // This is a weighted random selection, a classic algorithm.
      let random = Math.random() * totalWeight;

      // Algorithm-to-weight pairs to iterate through.
      const algoWeightsKeyPairs = Object.entries(currentWeights) as [
        RandomScreenshotAlgorithm,
        number
      ][];

      // Iterate through the algorithms and their weights until we find a winner for the
      // running random number.
      // Remember: this loop does not iterate through algorithms to call each one until a
      // screenshot is found, it just selects a random algorithm; the former is the role of
      // the outer loop.
      for (const [algorithm, weight] of algoWeightsKeyPairs) {
        // If the random number is higher than the weight of the current algorithm, subtract
        // the weight from the random number and try the next algorithm.
        if (random >= weight) {
          random -= weight;
          continue;
        }

        this.logger.debug(`Try screenshot selection algorithm: ${algorithm}`);

        // We found a winner, try to get a screenshot!
        // biome-ignore lint/performance/noAwaitInLoops: algorithmically needed.
        const screenshot = await this.randomScreenshotFunctions[algorithm](viewedIds);

        // If we found a screenshot, return it with the algorithm name.
        if (screenshot) {
          return { ...screenshot, __algorithm: algorithm };
        }

        // If we did not find a screenshot, remove the algorithm from the list of candidates
        // so it is not selected again, assigning a weight of 0 would work too.
        delete currentWeights[algorithm];

        // Break the for loop, we tried this algorithm, the outer loop will call us again to
        // try another one, if there are any left.
        break;
      }
    }
  }

  /**
   * Checks if a user has uploaded too many screenshots in the last 24 hours.
   * A user is identified by their creator ID or hardware ID, meaning two Creator IDs with the
   * same hardware ID will share the same quota.
   *
   * @throws ScreenshotRateLimitExceededError If the limit is reached.
   */
  private async checkUploadLimit(creator: Pick<Creator, 'id' | 'ips' | 'hwids'>): Promise<void> {
    // Let's find out by retrieving the screenshots uploaded in the last 24 hours, oldest first,
    // so if the limit is reached, we can check based on the date when the next screenshot can
    // be uploaded.
    const latestScreenshots = await this.prisma.screenshot.findMany({
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
      where: {
        // biome-ignore lint/style/useNamingConvention: prisma
        OR: [
          { creatorId: creator.id },
          { hwid: { in: creator.hwids } },
          { ip: { in: creator.hwids } }
        ],
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
   * Retrieves a non-reported completely random screenshot.
   */
  private getScreenshotRandom(nin: readonly JsonOid[]): Promise<Screenshot | null> {
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
   * Retrieves a non-reported screenshot that has a high number of "likes" (favorites) *per day*.
   */
  private getScreenshotTrending(nin: readonly JsonOid[]): Promise<Screenshot | null> {
    // Uses [isReported, favoritingPercentage] compound index for sorting with limiting and
    // filtering, test changes to ensure index usage.
    return this.runAggregateForSingleScreenshot([
      {
        $match: {
          _id: { $nin: nin },
          favoritingPercentage: { $gt: 1 },
          isReported: false
        }
      },
      { $sort: { favoritingPercentage: -1 } },
      { $limit: ScreenshotService.sampleSizeForDeterministicAlgorithms },
      { $sample: { size: 1 } }
    ]);
  }

  /**
   * Retrieves a non-reported random screenshot uploaded within the last X days (configurable as an
   * environment variable).
   */
  private getScreenshotRecent(nin: readonly JsonOid[]): Promise<Screenshot | null> {
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
   * Retrieves a non-reported screenshot that was uploaded more than X days ago (configurable in
   * env), has the lowest number of views, and then prioritizes the oldest screenshots.
   */
  private getScreenshotArcheologist(nin: readonly JsonOid[]): Promise<Screenshot | null> {
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
   * Retrieves a non-reported random screenshot from a random supporter.
   * Prioritizes the oldest screenshots with the fewest views for the randomly selected supporter.
   */
  private async getScreenshotSupporter(nin: readonly JsonOid[]): Promise<Screenshot | null> {
    const supporters = await this.prisma.creator.aggregateRaw({
      pipeline: [
        { $match: { isSupporter: true } },
        { $sample: { size: 1 } },
        { $project: { _id: true } }
      ]
    });

    assert(Array.isArray(supporters), `Expected an array of 0..1 results.`);

    const supporter = supporters[0];
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
   * Runs an aggregate pipeline that retrieves a single screenshot (for use by
   * {@link randomScreenshotFunctions} functions), ensures that the result is valid, and returns a
   * handcrafted {@link Screenshot} instead of a POJO.
   */
  private async runAggregateForSingleScreenshot(
    pipeline: Prisma.InputJsonValue[]
  ): Promise<Screenshot | null> {
    const results = await this.prisma.screenshot.aggregateRaw({
      pipeline
    });

    assert(Array.isArray(results), `Expected an array of 0..1 results.`);

    const screenshot = results[0];
    if (!screenshot?._id?.$oid) {
      return null;
    }

    return {
      id: screenshot._id.$oid,
      createdAt: new Date(screenshot.createdAt.$date),
      isApproved: screenshot.isApproved,
      isReported: screenshot.isReported,
      reportedById: screenshot.reportedById,
      favoritesCount: screenshot.favoritesCount,
      favoritingPercentage: screenshot.favoritingPercentage,
      uniqueViewsCount: screenshot.uniqueViewsCount,
      viewsCount: screenshot.viewsCount,
      hwid: screenshot.hwid,
      ip: screenshot.ip,
      creatorId: screenshot.creatorId.$oid,
      cityName: screenshot.cityName,
      cityNameLocale: screenshot.cityNameLocale,
      cityNameLatinized: screenshot.cityNameLatinized,
      cityNameTranslated: screenshot.cityNameTranslated,
      needsTranslation: screenshot.needsTranslation,
      cityMilestone: screenshot.cityMilestone,
      cityPopulation: screenshot.cityPopulation,
      imageUrlThumbnail: screenshot.imageUrlThumbnail,
      imageUrlFHD: screenshot.imageUrlFHD,
      imageUrl4K: screenshot.imageUrl4K,
      paradoxModIds: screenshot.paradoxModIds,
      renderSettings: screenshot.renderSettings,
      metadata: screenshot.metadata
    };
  }
}

export abstract class ScreenshotError extends StandardError {}

export class ScreenshotApprovedError extends ScreenshotError {
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
