import assert from 'node:assert/strict';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Creator, Prisma, Screenshot } from '@prisma/client';
import * as sentry from '@sentry/bun';
import Bun from 'bun';
import { oneLine } from 'common-tags';
import * as dfns from 'date-fns';
import { FastifyRequest } from 'fastify';
import { filesize } from 'filesize';
import {
  HardwareID,
  IPAddress,
  JsonObject,
  Maybe,
  ParadoxModID,
  StandardError,
  optionallySerialized
} from '../common';
import { isPrismaError } from '../common/prisma-errors';
import { config } from '../config';
import { AiTranslatorService } from './ai-translator.service';
import { CreatorService } from './creator.service';
import { DateFnsLocalizationService } from './date-fns-localization.service';
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

type JsonOid = { readonly $oid: string };

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
  public async ingestScreenshot({
    ip,
    hwid,
    healthcheck,
    ...data
  }: {
    ip: Maybe<IPAddress>;
    hwid: Maybe<HardwareID>;
    creator: Pick<Creator, 'id' | 'creatorName' | 'creatorNameSlug'>;
    cityName: string;
    cityMilestone: number;
    cityPopulation: number;
    paradoxModIds: ReadonlySet<ParadoxModID>;
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

    if (hwid && ip) {
      // Check upload limit, throws if reached.
      await this.checkUploadLimit(data.creator.id, hwid, ip);
    }

    let mark = Date.now();

    // Generate the two resized screenshot from the uploaded file.
    const { imageThumbnailBuffer, imageFHDBuffer, image4KBuffer } =
      await this.screenshotProcessing.resizeScreenshots(data.file, {
        creatorName: data.creator.creatorName,
        cityName: data.cityName
      });

    this.logger.log(`Screenshot "${data.cityName}" resized (${Date.now() - mark}ms).`);
    mark = Date.now();

    // Create the screenshot in the database and upload the screenshots, in a transaction so if
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
      this.getBlobUrl(screenshot.imageUrlFHD)
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
          { id: screenshot.id, imageUrlOrBuffer: screenshot.imageUrlFHD }
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
          hwid: hwid ?? null,
          ip: ip ?? null,
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
          isReported: healthcheck // make sure healthcheck uploads are never shown
        }
      });

      // Upload the screenshots.
      const blobUrls = await this.screenshotStorage.uploadScreenshots(
        data.creator,
        screenshotWithoutBlobs,
        imageThumbnailBuffer,
        imageFHDBuffer,
        image4KBuffer
      );

      // Update the screenshot with the blob URLs.
      const screenshot = await prisma.screenshot.update({
        where: { id: screenshotWithoutBlobs.id },
        data: {
          imageUrlThumbnail: blobUrls.blobThumbnail,
          imageUrlFHD: blobUrls.blobFHD,
          imageUrl4K: blobUrls.blob4K
        }
      });

      if (healthcheck) {
        await this.deleteScreenshot(screenshot.id, prisma);
      }

      return screenshot;
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
      prisma: Prisma.TransactionClient
    ): Promise<Screenshot> {
      try {
        await this.screenshotSimilarityDetector.deleteEmbedding(screenshotId, prisma);

        const screenshot = await prisma.screenshot.delete({
          where: { id: screenshotId }
        });

        await this.screenshotStorage.deleteScreenshots(screenshot);

        this.logger.log(`Deleted screenshot #${screenshot.id} "${screenshot.cityName}".`);

        return screenshot;
      } catch (error) {
        if (isPrismaError(error) && error.code == 'P2025') {
          throw new ScreenshotNotFoundError(screenshotId, {
            cause: error
          });
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
      throw new ScreenshotNotFoundError(screenshotId);
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
        throw new ScreenshotNotFoundError(screenshotId, {
          cause: error
        });
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
        throw new ScreenshotNotFoundError(screenshotId, {
          cause: error
        });
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
   * are reused. This serves both the purpose of saving on OpenAI requests but most importantly make
   * sure we have a stable translation for different uploads of the same city.
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
    // Get the IDs of the screenshots viewed by the user, to avoid showing them screenshots they
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

    // Try to get a screenshot using the weighted random selection and taking in account the
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
    screenshot: Screenshot & { creator?: Creator },
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
      favoritesPerDay: screenshot.favoritesPerDay,
      favoritingPercentage: screenshot.favoritingPercentage,
      viewsCount: screenshot.viewsCount,
      viewsPerDay: screenshot.viewsPerDay,
      cityName: screenshot.cityName,
      cityNameLocale: screenshot.cityNameLocale,
      cityNameLatinized: screenshot.cityNameLatinized,
      cityNameTranslated: screenshot.cityNameTranslated,
      cityMilestone: screenshot.cityMilestone,
      cityPopulation: screenshot.cityPopulation,
      imageUrlThumbnail: this.getBlobUrl(screenshot.imageUrlThumbnail),
      imageUrlFHD: this.getBlobUrl(screenshot.imageUrlFHD),
      imageUrl4K: this.getBlobUrl(screenshot.imageUrl4K),
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
      )
    };
  }

  /**
   * Retrieves the complete URL for a screenshot blob name.
   */
  public getBlobUrl(blobName: string): string {
    return `${config.azure.cdn}/${config.azure.screenshotsContainer}/${blobName}`;
  }

  /**
   * Updates the average views and favorites per day for each screenshot in the database.
   *
   * Averages are rounded to one decimal place and updates are only made if the difference between
   * the calculated average and the stored average is greater than 0.1.
   *
   * The cron is scheduled to run every hour. It can also be run from the CLI with
   * `bun run:cli update-screenshots-averages`.
   */
  @Cron('0 0 * * * *')
  public async updateAverageViewsAndFavoritesPerDay(nice = true): Promise<number> {
    this.logger.log(`Start updating screenshots average views and favorites per day.`);

    const screenshots = await this.prisma.screenshot.findMany({
      where: {
        // biome-ignore lint/style/useNamingConvention: prisma
        OR: [{ favoritesCount: { gt: 0 } }, { viewsCount: { gt: 0 } }]
      },
      select: {
        id: true,
        createdAt: true,
        viewsCount: true,
        viewsPerDay: true,
        favoritesCount: true,
        favoritesPerDay: true,
        favoritingPercentage: true
      }
    });

    this.logger.log(`Found ${screenshots.length} screenshots to update.`);

    const viewsImplementationDate = new Date('2024-09-23');
    const favoritesImplementationDate = new Date('2024-10-5');

    let updatedCount = 0;
    let lastProgress = 0;

    for (let index = 0; index < screenshots.length; index++) {
      // biome-ignore lint/style/noNonNullAssertion: cannot be null
      const screenshot = screenshots[index]!;

      const progress = Math.floor(((index + 1) / screenshots.length) * 100);

      if (progress % 10 == 0 && progress != lastProgress) {
        this.logger.log(
          `Screenshot averages update progress: ${progress}% (${index + 1}/${screenshots.length})`
        );

        lastProgress = progress;
      }

      const favoritesRefTime = Math.max(
        favoritesImplementationDate.getTime(),
        screenshot.createdAt.getTime()
      );

      const viewsRefTime = Math.max(
        viewsImplementationDate.getTime(),
        screenshot.createdAt.getTime()
      );

      let favoritesPerDay =
        screenshot.favoritesCount / ((Date.now() - favoritesRefTime) / 1000 / 60 / 60 / 24);

      let viewsPerDay = screenshot.viewsCount / ((Date.now() - viewsRefTime) / 1000 / 60 / 60 / 24);

      favoritesPerDay = Math.round(favoritesPerDay * 10) / 10;
      viewsPerDay = Math.round(viewsPerDay * 10) / 10;

      const favoritingPercentage = Math.round(
        (screenshot.favoritesCount / screenshot.viewsCount) * 100
      );

      // Check if saved averages are different from the calculated one by more than 0.1;
      // if it is, update the average.
      if (
        Math.abs(screenshot.favoritesPerDay - favoritesPerDay) > 0.1 ||
        Math.abs(screenshot.viewsPerDay - viewsPerDay) > 0.1 ||
        screenshot.favoritingPercentage != favoritingPercentage
      ) {
        await this.prisma.screenshot.update({
          where: { id: screenshot.id },
          data: { viewsPerDay, favoritesPerDay, favoritingPercentage }
        });

        updatedCount++;

        if (nice) {
          await Bun.sleep(100);
        }
      }
    }

    this.logger.log(`Done updating screenshots averages, updated ${updatedCount} screenshots.`);

    return updatedCount;
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
        return undefined;
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
  private async checkUploadLimit(
    creatorId: Creator['id'],
    hwid: HardwareID,
    ip: IPAddress
  ): Promise<void> {
    // Let's find out by retrieving the screenshots uploaded in the last 24 hours, oldest first,
    // so if the limit is reached, we can check based on the date when the next screenshot can
    // be uploaded.
    const latestScreenshots = await this.prisma.screenshot.findMany({
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
      where: {
        // biome-ignore lint/style/useNamingConvention: prisma
        OR: [{ creatorId }, { hwid }, { ip }],
        createdAt: { gt: dfns.subDays(new Date(), 1) }
      }
    });

    // If the limit is reached, throw the error.
    if (latestScreenshots.length >= config.screenshots.limitPer24h) {
      throw new ScreenshotRateLimitExceededError(
        config.screenshots.limitPer24h,
        // biome-ignore lint/style/noNonNullAssertion: cannot be null
        dfns.addDays(latestScreenshots[0]!.createdAt, 1)
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
   * Retrieves a non-reported screenshot that has a high amount of "likes" (favorites) *per day*.
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
   * Retrieves a non-reported random screenshot that was uploaded within the last X days
   * (configurable in env).
   */
  private getScreenshotRecent(nin: readonly JsonOid[]): Promise<Screenshot | null> {
    const $date = dfns.subDays(new Date(), config.screenshots.recencyThresholdDays);

    // Uses [isReported, createdAt] compound index for sorting with limiting and filtering when
    // there are less than sampleSize results, and [isReported, viewsCount, createdAt] when
    // there are more than sampleSize results, test changes to ensure index usage.
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
   * env), has the lowest amount of views, and then prioritizes the oldest screenshots.
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
   * Prioritizes the oldest screenshots with the least views for the randomly-selected supporter.
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
      favoritesPerDay: screenshot.favoritesPerDay,
      favoritingPercentage: screenshot.favoritingPercentage,
      viewsCount: screenshot.viewsCount,
      viewsPerDay: screenshot.viewsPerDay,
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

export class ScreenshotNotFoundError extends ScreenshotError {
  public constructor(
    public readonly id: Screenshot['id'],
    options?: ErrorOptions
  ) {
    super(`Could not find screenshot #${id}.`, options);
  }
}

export class ScreenshotApprovedError extends ScreenshotError {
  public constructor(
    public readonly screenshot: Pick<Screenshot, 'cityName'> & {
      creator: Pick<Creator, 'creatorName'>;
    },
    public readonly supportContact: string,
    options?: ErrorOptions
  ) {
    super(
      oneLine`
      Screenshot "${screenshot.cityName}" by ${screenshot.creator.creatorName} has already been
      approved manually by an administrator, and hence can't be reported.
      If you think this is a mistake, please contact support (${supportContact}).`,
      options
    );
  }
}

export class ScreenshotRateLimitExceededError extends ScreenshotError {
  public constructor(
    public readonly limit: number,
    public readonly notBefore: Date
  ) {
    super(
      oneLine`
      You can only upload a maximum of ${limit} screenshots every 24 hours.
      Your next slot will not open before ${notBefore.toLocaleString()} UTC.`
    );
  }
}
