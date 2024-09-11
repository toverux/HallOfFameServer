import assert from 'node:assert/strict';
import * as timers from 'node:timers';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Creator, Prisma, Screenshot } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { oneLine } from 'common-tags';
import * as dateFns from 'date-fns';
import {
    IPAddress,
    JsonObject,
    Maybe,
    StandardError,
    optionallySerialized
} from '../common';
import { config } from '../config';
import { CreatorService } from './creator.service';
import { PrismaService } from './prisma.service';
import { ScreenshotProcessingService } from './screenshot-processing.service';
import { ScreenshotStorageService } from './screenshot-storage.service';
import { ViewService } from './view.service';

type RandomScreenshotAlgorithm =
    | 'random'
    | 'recent'
    | 'archeologist'
    | 'supporter';

type RandomScreenshotWeights = Record<RandomScreenshotAlgorithm, number>;

type RandomScreenshotFunctions = Record<
    RandomScreenshotAlgorithm,
    (nin: readonly Screenshot['id'][]) => Promise<Screenshot | null>
>;

@Injectable()
export class ScreenshotService {
    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    @Inject(CreatorService)
    private readonly creatorService!: CreatorService;

    @Inject(ViewService)
    private readonly viewService!: ViewService;

    @Inject(ScreenshotProcessingService)
    private readonly screenshotProcessing!: ScreenshotProcessingService;

    @Inject(ScreenshotStorageService)
    private readonly screenshotStorage!: ScreenshotStorageService;

    private readonly logger = new Logger(ScreenshotService.name);

    private readonly randomScreenshotFunctions: RandomScreenshotFunctions = {
        random: this.getScreenshotRandom.bind(this),
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
    public async ingestScreenshot(
        ipAddress: Maybe<IPAddress>,
        creator: Pick<Creator, 'id' | 'creatorName'>,
        cityName: string,
        cityMilestone: number,
        cityPopulation: number,
        createdAt: Date,
        file: Buffer
    ): Promise<Screenshot> {
        if (ipAddress) {
            // Check upload limit, throws if reached.
            await this.checkUploadLimit(ipAddress, creator.id);
        }

        // Generate the two resized screenshot from the uploaded file.
        const { imageThumbnailBuffer, imageFHDBuffer, image4KBuffer } =
            await this.screenshotProcessing.resizeScreenshots(file, {
                creatorName: creator.creatorName,
                cityName
            });

        // Create the screenshot in the database and upload the screenshots,
        // in a transaction so if the upload fails, the database is not updated.
        return this.prisma.$transaction(async prisma => {
            // Create the screenshot in the database.
            const screenshotWithoutBlobs = await prisma.screenshot.create({
                select: { id: true, cityName: true },
                data: {
                    createdAt,
                    ipAddress: ipAddress ?? null,
                    creatorId: creator.id,
                    cityName,
                    cityMilestone,
                    cityPopulation,
                    imageUrlThumbnail: '',
                    imageUrlFHD: '',
                    imageUrl4K: ''
                }
            });

            // Upload the screenshots.
            const blobUrls = await this.screenshotStorage.uploadScreenshots(
                creator,
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

            this.logger.log(
                `Created screenshot #${screenshot.id} "${screenshot.cityName}".`
            );

            return screenshot;
        });
    }

    /**
     * Marks a screenshot as reported by a user.
     *
     * @param screenshotId Screenshot to mark as reported.
     * @param reportedBy   The IP address of the user who made the report.
     *                     Useful to reset a bunch of reports if the report
     *                     feature is abused.
     */
    public async markReported(
        screenshotId: Screenshot['id'],
        reportedBy: IPAddress
    ): Promise<Screenshot> {
        try {
            return await this.prisma.screenshot.update({
                where: { id: screenshotId },
                data: { isReported: true, reportedBy },
                include: { creator: true }
            });
        } catch (error) {
            if (
                error instanceof PrismaClientKnownRequestError &&
                error.code == 'P2025'
            ) {
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
    public async unmarkReported(
        screenshotId: Screenshot['id']
    ): Promise<Screenshot> {
        try {
            return await this.prisma.screenshot.update({
                where: { id: screenshotId },
                data: { isReported: false, reportedBy: null },
                include: { creator: true }
            });
        } catch (error) {
            if (
                error instanceof PrismaClientKnownRequestError &&
                error.code == 'P2025'
            ) {
                throw new ScreenshotNotFoundError(screenshotId, {
                    cause: error
                });
            }

            throw error;
        }
    }

    /**
     * Retrieves a random screenshot from the Hall of Fame, with weights to
     * assign probabilities to select the algorithm used to find a screenshot
     * ({@link RandomScreenshotAlgorithm}), algorithms with a higher weight have
     * a higher probability of being selected.
     *
     * If no screenshot is found by the algorithm that was randomly selected,
     * it falls back to {@link getScreenshotRandom}.
     */
    public async getWeightedRandomScreenshot(
        weights: RandomScreenshotWeights,
        markViewed: boolean,
        ipAddress: IPAddress,
        creatorId: Creator['id'],
        alreadyViewedMaxAgeInDays: number | undefined
    ): Promise<Screenshot & { __algorithm: RandomScreenshotAlgorithm }> {
        const viewedScreenshotIds =
            await this.viewService.getViewedScreenshotIds(
                ipAddress,
                creatorId,
                alreadyViewedMaxAgeInDays
            );

        // Get the total weight.
        const totalWeight = Object.values(weights).reduce(
            (total, weight) => total + weight,
            0
        );

        // Generate a random number between 0 and the total weight.
        let random = Math.random() * totalWeight;

        // Find the screenshot based on the random number.
        let screenshot: Screenshot | null = null;
        let algorithm: RandomScreenshotAlgorithm = 'random';

        for (const [algo, weight] of Object.entries(weights)) {
            if (random < weight) {
                screenshot =
                    await this.randomScreenshotFunctions[
                        algo as RandomScreenshotAlgorithm
                    ](viewedScreenshotIds);

                if (screenshot) {
                    algorithm = algo as RandomScreenshotAlgorithm;
                }

                break;
            }

            random -= weight;
        }

        // If no screenshot was found by an algorithm other than random,
        // fallback to a random screenshot.
        screenshot ??= await this.getScreenshotRandom();

        // We should always have a screenshot at this point, if not either the
        // database is empty or we have a bug.
        assert(screenshot, `Not a single screenshot found. Empty database?`);

        // noinspection JSObjectNullOrUndefined False positive
        if (markViewed && !viewedScreenshotIds.includes(screenshot.id)) {
            // Do it asynchronously so the response is not delayed.
            timers.setImmediate(() => {
                void this.viewService.markViewed(
                    screenshot.id,
                    ipAddress,
                    creatorId
                );
            });
        }

        return { ...screenshot, __algorithm: algorithm };
    }

    /**
     * Serializes a {@link Screenshot} to a JSON object for API responses.
     */
    public serialize(
        screenshot: Screenshot & { creator?: Creator }
    ): JsonObject {
        return {
            id: screenshot.id,
            isReported: screenshot.isReported,
            views: screenshot.views,
            cityName: screenshot.cityName,
            cityMilestone: screenshot.cityMilestone,
            cityPopulation: screenshot.cityPopulation,
            imageUrlThumbnail: this.getBlobUrl(screenshot.imageUrlThumbnail),
            imageUrlFHD: this.getBlobUrl(screenshot.imageUrlFHD),
            imageUrl4K: this.getBlobUrl(screenshot.imageUrl4K),
            createdAt: screenshot.createdAt.toISOString(),
            creator: optionallySerialized(
                screenshot.creator &&
                    this.creatorService.serialize(screenshot.creator)
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
     * Checks if the creator and/or the IP address has uploaded too many
     * screenshots in the last 24 hours.
     *
     * @throws ScreenshotRateLimitExceededError If the limit is reached.
     */
    private async checkUploadLimit(
        ipAddress: IPAddress,
        creatorId: Creator['id']
    ): Promise<void> {
        // Let's find out by retrieving the screenshots uploaded in the last 24
        // hours, oldest first, so if the limit is reached, we can check based
        // on the date when the next screenshot can be uploaded.
        const latestScreenshots = await this.prisma.screenshot.findMany({
            select: { createdAt: true },
            orderBy: { createdAt: 'asc' },
            where: {
                // biome-ignore lint/style/useNamingConvention: prisma
                OR: [{ creatorId }, { ipAddress }],
                createdAt: { gt: dateFns.subDays(new Date(), 1) }
            }
        });

        // If the limit is reached, throw the error.
        if (latestScreenshots.length >= config.screenshots.limitPer24h) {
            throw new ScreenshotRateLimitExceededError(
                config.screenshots.limitPer24h,
                // biome-ignore lint/style/noNonNullAssertion: cannot be null
                dateFns.addDays(latestScreenshots[0]!.createdAt, 1)
            );
        }
    }

    /**
     * Retrieves a non-reported completely random screenshot.
     */
    private getScreenshotRandom(
        nin: readonly Screenshot['id'][] = []
    ): Promise<Screenshot | null> {
        return this.runAggregateForSingleScreenshot([
            {
                $match: {
                    _id: { $nin: nin.map(id => ({ $oid: id })) },
                    isReported: false
                }
            },
            { $sample: { size: 1 } }
        ]);
    }

    /**
     * Retrieves a non-reported random screenshot that was uploaded within the
     * last X days (configurable in env).
     */
    private getScreenshotRecent(
        nin: readonly Screenshot['id'][] = []
    ): Promise<Screenshot | null> {
        const $date = dateFns.subDays(
            new Date(),
            config.screenshots.recencyThresholdDays
        );

        return this.runAggregateForSingleScreenshot([
            {
                $match: {
                    _id: { $nin: nin.map(id => ({ $oid: id })) },
                    isReported: false,
                    createdAt: { $gt: { $date } }
                }
            },
            { $sort: { views: 1, createdAt: 1 } },
            { $limit: 1 }
        ]);
    }

    /**
     * Retrieves a non-reported screenshot that was uploaded more than X days
     * ago (configurable in env) ago, has the lowest amount of views, and then
     * prioritizes the oldest screenshots.
     *
     * ###### Implementation Notes
     * This query scans the entire collection (minus last X days for recency and
     * reported posts), so I was worried about performance and wondered if I
     * should add a `{ $sample: { size: aRelativelyBigNumber } }` to limit the
     * amount of documents scanned.
     * After testing on ~110k documents, it seems that `{ $sample }`, before or
     * after `{ $match }`, breaks various MongoDB optimizations (index usage,
     * in-memory sorting, etc.), so it was actually ~30% slower.
     * I guess a "big data" approach would be to use other optimization
     * techniques like pre-aggregating data, or use `{ $sample }` only for much
     * larger collections.
     * Anyway, even on 110k documents, the query was still very fast and light
     * due to MongoDB's optimizations, and we still transfer only one document
     * so throughput is not a concern.
     */
    private getScreenshotArcheologist(
        nin: readonly Screenshot['id'][] = []
    ): Promise<Screenshot | null> {
        const $date = dateFns.subDays(
            new Date(),
            config.screenshots.recencyThresholdDays
        );

        return this.runAggregateForSingleScreenshot([
            {
                $match: {
                    _id: { $nin: nin.map(id => ({ $oid: id })) },
                    isReported: false,
                    createdAt: { $lt: { $date } }
                }
            },
            { $sort: { views: 1, createdAt: 1 } },
            { $limit: 1 }
        ]);
    }

    /**
     * Retrieves a non-reported random screenshot from a random supporter.
     * Prioritizes the oldest screenshots with the least views for the
     * randomly-selected supporter.
     *
     * ###### Implementation Notes
     * Same performance considerations as {@link getScreenshotArcheologist} for
     * the screenshots' aggregation.
     */
    private async getScreenshotSupporter(
        nin: readonly Screenshot['id'][] = []
    ): Promise<Screenshot | null> {
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
                    _id: { $nin: nin.map(id => ({ $oid: id })) },
                    isReported: false,
                    creatorId: supporter._id
                }
            },
            { $sort: { views: 1, createdAt: 1 } },
            { $limit: 1 }
        ]);
    }

    /**
     * Runs an aggregate pipeline that retrieves a single screenshot (for use
     * by {@link randomScreenshotFunctions} functions), ensures that the result
     * is valid, and returns a handcrafted {@link Screenshot} instead of a POJO.
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
            isReported: screenshot.isReported,
            reportedBy: screenshot.reportedBy,
            views: screenshot.views,
            ipAddress: screenshot.ipAddress,
            creatorId: screenshot.creatorId.$oid,
            cityName: screenshot.cityName,
            cityMilestone: screenshot.cityMilestone,
            cityPopulation: screenshot.cityPopulation,
            imageUrlThumbnail: screenshot.imageUrlThumbnail,
            imageUrlFHD: screenshot.imageUrlFHD,
            imageUrl4K: screenshot.imageUrl4K
        };
    }
}

export abstract class ScreenshotError extends StandardError {}

export class ScreenshotNotFoundError extends ScreenshotError {
    public constructor(id: Screenshot['id'], options?: ErrorOptions) {
        super(oneLine`Could not find screenshot #${id}.`, options);
    }
}

export class ScreenshotRateLimitExceededError extends ScreenshotError {
    public constructor(
        public readonly limit: number,
        public readonly notBefore: Date
    ) {
        super(oneLine`
            You can only upload a maximum of ${limit} screenshots every 24
            hours. Your next slot will not open before
            ${notBefore.toLocaleString()} UTC.`);
    }
}
