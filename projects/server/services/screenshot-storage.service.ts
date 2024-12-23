import { ContainerClient } from '@azure/storage-blob';
import { Injectable } from '@nestjs/common';
import { Creator, Screenshot } from '@prisma/client';
import * as dateFns from 'date-fns';
import slug from 'slug';
import { allFulfilled } from '../common';
import { config } from '../config';
import { AzureService } from './azure.service';

@Injectable()
export class ScreenshotStorageService {
    private readonly containerClient: ContainerClient;

    public constructor(azure: AzureService) {
        this.containerClient = azure.blobServiceClient.getContainerClient(
            config.azure.screenshotsContainer
        );
    }

    public async downloadScreenshotToFile(blobName: string, filePath: string): Promise<void> {
        await this.containerClient.getBlobClient(blobName).downloadToFile(filePath);
    }

    public async uploadScreenshots(
        creator: Pick<Creator, 'id' | 'creatorNameSlug'>,
        screenshot: Pick<Screenshot, 'id' | 'cityName'>,
        bufferThumbnail: Buffer,
        bufferFHD: Buffer,
        buffer4K: Buffer
    ): Promise<{ blobThumbnail: string; blobFHD: string; blob4K: string }> {
        const containerClient = this.containerClient;

        const date = dateFns.format(new Date(), 'yyyy-MM-dd-HH-mm-ss');

        const cityNameSlug = slug(screenshot.cityName, { fallback: false });

        const creatorNameSlug =
            creator.creatorNameSlug && slug(creator.creatorNameSlug, { fallback: false });

        // slug will return an empty string if the input only has characters that it cannot slugify
        // or transliterate, for example Chinese, so we need to handle fallbacks.
        const contextSlug =
            cityNameSlug && creatorNameSlug
                ? `${cityNameSlug}-by-${creatorNameSlug}`
                : cityNameSlug || creatorNameSlug || 'screenshot';

        const blobNameBase = `${creator.id}/${screenshot.id}/${contextSlug}-${date}`;

        const [blobNameThumbnail, blobNameFHD, blobName4K] = await allFulfilled([
            upload(`${blobNameBase}-thumbnail.jpg`, bufferThumbnail),
            upload(`${blobNameBase}-fhd.jpg`, bufferFHD),
            upload(`${blobNameBase}-4k.jpg`, buffer4K)
        ]);

        return {
            blobThumbnail: blobNameThumbnail,
            blobFHD: blobNameFHD,
            blob4K: blobName4K
        };

        async function upload(blobName: string, buffer: Buffer) {
            const { blockBlobClient } = await containerClient.uploadBlockBlob(
                blobName,
                buffer,
                buffer.length,
                {
                    tags: {
                        creatorId: creator.id,
                        screenshotId: screenshot.id
                    },
                    blobHTTPHeaders: {
                        blobContentType: 'image/jpeg'
                    }
                }
            );

            return blockBlobClient.name;
        }
    }

    public async deleteScreenshots(
        screenshot: Pick<Screenshot, 'imageUrlThumbnail' | 'imageUrlFHD' | 'imageUrl4K'>
    ): Promise<void> {
        const containerClient = this.containerClient;

        await allFulfilled([
            deleteBlob(screenshot.imageUrlThumbnail),
            deleteBlob(screenshot.imageUrlFHD),
            deleteBlob(screenshot.imageUrl4K)
        ]);

        function deleteBlob(blobName: string) {
            return containerClient.getBlobClient(blobName).delete({ deleteSnapshots: 'include' });
        }
    }
}
