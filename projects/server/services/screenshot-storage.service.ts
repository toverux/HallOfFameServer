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

  // Pure, which `this: void` enforces, so the tests' storage fake reuses it.
  public getScreenshotUrl(this: void, blobName: string): string {
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
  }): Promise<ScreenshotBlobNames> {
    const { containerClient } = this;

    const blobNames = getScreenshotBlobNames(data.creator, data.screenshot, new Date());

    await allFulfilled([
      upload(blobNames.blobThumbnail, data.bufferThumbnail),
      upload(blobNames.blobFhd, data.bufferFhd),
      upload(blobNames.blob4k, data.buffer4K)
    ]);

    return blobNames;

    async function upload(blobName: string, buffer: Buffer): Promise<void> {
      await containerClient.uploadBlockBlob(blobName, buffer, buffer.length, {
        tags: {
          creatorId: data.creator.id,
          screenshotId: data.screenshot.id
        },
        blobHTTPHeaders: {
          blobContentType: 'image/jpeg'
        }
      });
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

export interface ScreenshotBlobNames {
  readonly blobThumbnail: string;
  readonly blobFhd: string;
  readonly blob4k: string;
}

/**
 * Names the three blobs of a screenshot uploaded at `date`, grouped by creator then screenshot,
 * with a readable slug of the city and creator names.
 */
export function getScreenshotBlobNames(
  creator: Pick<Creator, 'id' | 'creatorNameSlug'>,
  screenshot: Pick<Screenshot, 'id' | 'cityName'>,
  date: Date
): ScreenshotBlobNames {
  const cityNameSlug = slug(screenshot.cityName, { fallback: false });

  const creatorNameSlug =
    creator.creatorNameSlug && slug(creator.creatorNameSlug, { fallback: false });

  // Slug will return an empty string if the input only has characters that it cannot slugify
  // or transliterate, ex. Chinese, so we need to handle fallbacks.
  const contextSlug =
    cityNameSlug && creatorNameSlug
      ? `${cityNameSlug}-by-${creatorNameSlug}`
      : // oxlint-disable-next-line typescript/prefer-nullish-coalescing - empty slug falls through
        cityNameSlug || creatorNameSlug || 'screenshot';

  const dateSlug = dateFns.format(date, 'yyyy-MM-dd-HH-mm-ss');

  const blobNameBase = `${creator.id}/${screenshot.id}/${contextSlug}-${dateSlug}`;

  return {
    blobThumbnail: `${blobNameBase}-thumbnail.jpg`,
    blobFhd: `${blobNameBase}-fhd.jpg`,
    blob4k: `${blobNameBase}-4k.jpg`
  };
}
