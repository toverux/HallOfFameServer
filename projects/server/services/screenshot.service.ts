import { Inject, Injectable, Logger } from '@nestjs/common';
import { Creator, Screenshot } from '@prisma/client';
import { oneLine } from 'common-tags';
import { JSONObject, StandardError } from '../common';
import { ConfigService } from './config.service';
import { PrismaService } from './prisma.service';
import { ScreenshotProcessingService } from './screenshot-processing.service';
import { ScreenshotUploaderService } from './screenshot-uploader.service';

@Injectable()
export class ScreenshotService {
    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    @Inject(ConfigService)
    private readonly config!: ConfigService;

    @Inject(ScreenshotProcessingService)
    private readonly screenshotProcessing!: ScreenshotProcessingService;

    @Inject(ScreenshotUploaderService)
    private readonly screenshotUploader!: ScreenshotUploaderService;

    private readonly logger = new Logger(ScreenshotService.name);

    /**
     * Ingests a screenshot and its metadata into the Hall of Fame.
     *
     * By ingesting a screenshot, we mean:
     * - Resizing the screenshot to two sizes.
     * - Uploading the screenshots to Azure Blob Storage.
     * - Creating a {@link Screenshot} record in the database.
     */
    public async ingestScreenshot(
        ipAddress: string,
        creator: Pick<Creator, 'id' | 'creatorName'>,
        cityName: string,
        cityPopulation: number,
        file: Buffer
    ): Promise<Screenshot> {
        // Check upload limit, throws if reached.
        await this.checkUploadLimit(ipAddress, creator.id);

        // Generate the two resized screenshot from the uploaded file.
        const { imageFHDBuffer, image4KBuffer } =
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
                    ipAddress,
                    creatorId: creator.id,
                    cityName,
                    cityPopulation,
                    imageUrlFHD: '',
                    imageUrl4K: ''
                }
            });

            // Upload the screenshots.
            const blobUrls = await this.screenshotUploader.uploadScreenshots(
                creator,
                screenshotWithoutBlobs,
                imageFHDBuffer,
                image4KBuffer
            );

            // Update the screenshot with the blob URLs.
            const screenshot = await prisma.screenshot.update({
                where: { id: screenshotWithoutBlobs.id },
                data: {
                    imageUrlFHD: blobUrls.blobFHD,
                    imageUrl4K: blobUrls.blob4K
                }
            });

            this.logger.log(
                `Created screenshot #${screenshot.id} "${screenshot.cityName}".`,
                { screenshot, creator }
            );

            return screenshot;
        });
    }

    /**
     * Serializes a {@link Screenshot} to a JSON object for API responses.
     */
    public serialize(screenshot: Screenshot): JSONObject {
        return {
            id: screenshot.id,
            approved: screenshot.approved,
            creatorId: screenshot.creatorId,
            cityName: screenshot.cityName,
            cityPopulation: screenshot.cityPopulation,
            imageUrlFHD: this.getBlobUrl(screenshot.imageUrlFHD),
            imageUrl4K: this.getBlobUrl(screenshot.imageUrl4K),
            createdAt: screenshot.createdAt.toISOString()
        };
    }

    private getBlobUrl(blobName: string): string {
        return `${this.config.azure.cdn}/${this.config.azure.screenshotsContainer}/${blobName}`;
    }

    /**
     * Checks if the creator and/or the IP address has uploaded too many
     * screenshots in the last 24 hours.
     *
     * @throws ScreenshotRateLimitExceededError If the limit is reached.
     */
    private async checkUploadLimit(
        ipAddress: string,
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
                createdAt: { gt: new Date(Date.now() - 1000 * 60 * 60 * 24) }
            }
        });

        // If the limit is reached, throw the error.
        if (latestScreenshots.length >= this.config.screenshotsLimitPer24h) {
            throw new ScreenshotRateLimitExceededError(
                this.config.screenshotsLimitPer24h,
                new Date(
                    // biome-ignore lint/style/noNonNullAssertion: cannot be null
                    latestScreenshots[0]!.createdAt.getTime() +
                        1000 * 60 * 60 * 24
                )
            );
        }
    }
}

export abstract class ScreenshotError extends StandardError {}

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
