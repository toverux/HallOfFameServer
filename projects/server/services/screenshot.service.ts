import { Inject, Injectable, Logger } from '@nestjs/common';
import { Creator, Screenshot } from '@prisma/client';
import { JSONObject } from '../common';
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
        creator: Pick<Creator, 'id' | 'creatorName'>,
        cityName: string,
        cityPopulation: number,
        file: Buffer
    ): Promise<Screenshot> {
        // Generate the two resized screenshot from the uploaded file.
        const { imageFHDBuffer, image4KBuffer } =
            await this.screenshotProcessing.resizeScreenshots(file, {
                creatorName: creator.creatorName,
                cityName
            });

        return this.prisma.$transaction(async prisma => {
            // Create the screenshot in the database.
            const screenshotWithoutBlobs = await prisma.screenshot.create({
                select: { id: true, cityName: true },
                data: {
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
}
