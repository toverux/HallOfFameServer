/**
 * In-memory fakes of the services that reach external systems (Azure, OpenAI, the inference
 * worker), recording what they receive so tests can assert on it.
 * Each implements the methods the app reaches over HTTP; the CLI-only ones are left out.
 */

import type { ScreenshotFeatureEmbedding } from '#prisma-lib/client';
import {
  type AiTranslatorService,
  getScreenshotBlobNames,
  type ScreenshotBlobNames,
  type ScreenshotSimilarityDetectorService,
  ScreenshotStorageService,
  type TranslationResponse
} from '../services';

type Upload = Parameters<ScreenshotStorageService['uploadScreenshots']>[0];

type Deletion = Parameters<ScreenshotStorageService['deleteScreenshots']>[0];

export class FakeScreenshotStorageService implements Pick<
  ScreenshotStorageService,
  'getScreenshotUrl' | 'uploadScreenshots' | 'deleteScreenshots'
> {
  /**
   * The uploaded images, by blob name.
   */
  public readonly blobs = new Map<string, Buffer>();

  public readonly deletions: Deletion[] = [];

  // Pure, so the real implementation serves, and URLs match production.
  public readonly getScreenshotUrl = ScreenshotStorageService.prototype.getScreenshotUrl;

  // Names the blobs as production does, so the names are under test.
  public uploadScreenshots(data: Upload): Promise<ScreenshotBlobNames> {
    const blobNames = getScreenshotBlobNames(data.creator, data.screenshot, new Date());

    this.blobs.set(blobNames.blobThumbnail, data.bufferThumbnail);
    this.blobs.set(blobNames.blobFhd, data.bufferFhd);
    this.blobs.set(blobNames.blob4k, data.buffer4K);

    return Promise.resolve(blobNames);
  }

  public deleteScreenshots(screenshot: Deletion): Promise<void> {
    this.deletions.push(screenshot);

    return Promise.resolve();
  }
}

type TranslationOptions = Parameters<AiTranslatorService['translateCityName']>[0];

type TranslationRequest = TranslationOptions & { readonly kind: 'cityName' | 'creatorName' };

export class FakeAiTranslatorService implements Pick<
  AiTranslatorService,
  'translateCityName' | 'translateCreatorName'
> {
  public readonly requests: TranslationRequest[] = [];

  public translateCityName(options: TranslationOptions): Promise<TranslationResponse> {
    return this.translate({ kind: 'cityName', ...options });
  }

  public translateCreatorName(options: TranslationOptions): Promise<TranslationResponse> {
    return this.translate({ kind: 'creatorName', ...options });
  }

  private translate(request: TranslationRequest): Promise<TranslationResponse> {
    this.requests.push(request);

    return Promise.resolve({
      twoLetterLocaleCode: 'ja',
      transliteration: `${request.input} (transliterated)`,
      translation: `${request.input} (translated)`
    });
  }
}

type EmbeddingUpdate = Parameters<ScreenshotSimilarityDetectorService['batchUpdateEmbeddings']>[1];

export class FakeScreenshotSimilarityDetectorService implements Pick<
  ScreenshotSimilarityDetectorService,
  | 'batchUpdateEmbeddings'
  | 'deleteEmbedding'
  | 'findSimilarScreenshots'
  | 'allowScreenshotSimilarity'
> {
  public readonly embeddingUpdates: EmbeddingUpdate[] = [];

  public readonly embeddingDeletions: string[] = [];

  /**
   * The neighbours {@link findSimilarScreenshots} returns for any screenshot, which a test sets; it
   * keeps those within the maximum distance the caller asks for, as the detector does.
   */
  public readonly neighbours: Array<{ screenshotId: string; distance: number }> = [];

  public readonly allowedSimilarities: Array<readonly [string, string]> = [];

  public batchUpdateEmbeddings(
    _batchName: string,
    screenshots: EmbeddingUpdate
  ): Promise<ScreenshotFeatureEmbedding[]> {
    this.embeddingUpdates.push(screenshots);

    // Callers ignore the embeddings, and the fake infers none.
    return Promise.resolve([]);
  }

  public deleteEmbedding(screenshotId: string): Promise<void> {
    this.embeddingDeletions.push(screenshotId);

    return Promise.resolve();
  }

  public findSimilarScreenshots(
    screenshot: EmbeddingUpdate[number],
    maxDistance: number
  ): Promise<Array<{ screenshotId: string; distance: number }>> {
    // As the detector, which infers and stores the embedding of a screenshot that has none.
    this.embeddingUpdates.push([screenshot]);

    return Promise.resolve(this.neighbours.filter(neighbour => neighbour.distance <= maxDistance));
  }

  public allowScreenshotSimilarity(firstId: string, secondId: string): Promise<void> {
    this.allowedSimilarities.push([firstId, secondId]);

    return Promise.resolve();
  }
}
