import type { BlobDeleteIfExistsResponse, ContainerClient } from '@azure/storage-blob';
import { Inject, Injectable } from '@nestjs/common';
import * as dateFns from 'date-fns';
import slug from 'slug';
import type { Creator, Screenshot } from '#prisma-lib/client';
import { allFulfilled } from '../../shared/utils/all-fulfilled';
import { config } from '../config';
import { AzureService } from './azure.service';

@Injectable()
export class ScreenshotStorageService {
  private readonly containerClient: ContainerClient;

  public constructor(@Inject(AzureService) azure: AzureService) {
    this.containerClient = azure.blobServiceClient.getContainerClient(
      config.azure.screenshotsContainer
    );
  }

  public getScreenshotUrl(blobName: string): string {
    return `${config.azure.cdn}/${config.azure.screenshotsContainer}/${blobName}`;
  }

  public downloadScreenshotToBuffer(blobName: string): Promise<Buffer> {
    return this.containerClient.getBlobClient(blobName).downloadToBuffer();
  }

  public async downloadScreenshotToFile(blobName: string, filePath: string): Promise<void> {
    await this.containerClient.getBlobClient(blobName).downloadToFile(filePath);
  }

  public async uploadScreenshots(data: {
    creator: Pick<Creator, 'id' | 'creatorNameSlug'>;
    screenshot: Pick<Screenshot, 'id' | 'cityName'>;
    bufferThumbnail: Buffer;
    bufferFhd: Buffer;
    buffer4K: Buffer;
  }): Promise<{ blobThumbnail: string; blobFhd: string; blob4k: string }> {
    const { containerClient } = this;

    const date = dateFns.format(new Date(), 'yyyy-MM-dd-HH-mm-ss');

    const cityNameSlug = slug(data.screenshot.cityName, { fallback: false });

    const creatorNameSlug =
      data.creator.creatorNameSlug && slug(data.creator.creatorNameSlug, { fallback: false });

    // Slug will return an empty string if the input only has characters that it cannot slugify
    // or transliterate, ex. Chinese, so we need to handle fallbacks.
    const contextSlug =
      cityNameSlug && creatorNameSlug
        ? `${cityNameSlug}-by-${creatorNameSlug}`
        : // oxlint-disable-next-line typescript/prefer-nullish-coalescing - empty slug falls through
          cityNameSlug || creatorNameSlug || 'screenshot';

    const blobNameBase = `${data.creator.id}/${data.screenshot.id}/${contextSlug}-${date}`;

    const [blobNameThumbnail, blobNameFhd, blobName4K] = await allFulfilled([
      upload(`${blobNameBase}-thumbnail.jpg`, data.bufferThumbnail),
      upload(`${blobNameBase}-fhd.jpg`, data.bufferFhd),
      upload(`${blobNameBase}-4k.jpg`, data.buffer4K)
    ]);

    return {
      blobThumbnail: blobNameThumbnail,
      blobFhd: blobNameFhd,
      blob4k: blobName4K
    };

    async function upload(blobName: string, buffer: Buffer): Promise<string> {
      const { blockBlobClient } = await containerClient.uploadBlockBlob(
        blobName,
        buffer,
        buffer.length,
        {
          tags: {
            creatorId: data.creator.id,
            screenshotId: data.screenshot.id
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
    const { containerClient } = this;

    await allFulfilled([
      deleteBlob(screenshot.imageUrlThumbnail),
      deleteBlob(screenshot.imageUrlFHD),
      deleteBlob(screenshot.imageUrl4K)
    ]);

    function deleteBlob(blobName: string): Promise<BlobDeleteIfExistsResponse> {
      return containerClient.getBlobClient(blobName).deleteIfExists({ deleteSnapshots: 'include' });
    }
  }
}
