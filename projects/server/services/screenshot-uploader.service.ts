import { ContainerClient } from '@azure/storage-blob';
import { Injectable } from '@nestjs/common';
import { Creator, Screenshot } from '@prisma/client';
import * as dateFns from 'date-fns';
import slug from 'slug';
import { AzureService } from './azure.service';
import { ConfigService } from './config.service';

@Injectable()
export class ScreenshotUploaderService {
    private readonly containerClient: ContainerClient;

    public constructor(azure: AzureService, config: ConfigService) {
        this.containerClient = azure.blobServiceClient.getContainerClient(
            config.azure.screenshotsContainer
        );
    }

    public async uploadScreenshots(
        creator: Pick<Creator, 'id' | 'creatorName'>,
        screenshot: Pick<Screenshot, 'id' | 'cityName'>,
        bufferFHD: Buffer,
        buffer4K: Buffer
    ): Promise<{ blobFHD: string; blob4K: string }> {
        const containerClient = this.containerClient;

        const date = dateFns.format(new Date(), 'yyyy-MM-dd-HH-mm-ss');

        const blobSlug = slug(
            `${screenshot.cityName} by ${creator.creatorName} ${date}`
        );

        const blobNameBase = `${creator.id}/${screenshot.id}/${blobSlug}`;

        const blobNameFHD = `${blobNameBase}-fhd.jpg`;
        const blobName4K = `${blobNameBase}-4k.jpg`;

        const results = await Promise.allSettled([
            upload(blobNameFHD, bufferFHD),
            upload(blobName4K, buffer4K)
        ]);

        const firstFailedResult = results.find(
            result => result.status == 'rejected'
        );

        if (firstFailedResult) {
            throw firstFailedResult.reason;
        }

        return {
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
}
