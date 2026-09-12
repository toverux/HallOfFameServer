/**
 * In-memory fakes of the services that reach external systems (Azure, OpenAI, the inference
 * worker), recording what they receive so tests can assert on it.
 * Each implements the methods the app reaches over HTTP; the CLI-only ones are left out.
 */

import type { ScreenshotFeatureEmbedding } from '#prisma-lib/client';
import {
  type AiTranslatorService,
  type ScreenshotSimilarityDetectorService,
  ScreenshotStorageService,
  type TranslationResponse
} from '../services';

type Upload = Parameters<ScreenshotStorageService['uploadScreenshots']>[0];

type UploadedBlobNames = Awaited<ReturnType<ScreenshotStorageService['uploadScreenshots']>>;

type Deletion = Parameters<ScreenshotStorageService['deleteScreenshots']>[0];

export class FakeScreenshotStorageService implements Pick<
  ScreenshotStorageService,
  'getScreenshotUrl' | 'uploadScreenshots' | 'deleteScreenshots'
> {
  public readonly uploads: Upload[] = [];

  public readonly deletions: Deletion[] = [];

  // Pure, so the real implementation serves, and URLs match production.
  public readonly getScreenshotUrl = ScreenshotStorageService.prototype.getScreenshotUrl;

  public uploadScreenshots(data: Upload): Promise<UploadedBlobNames> {
    this.uploads.push(data);

    const blobNameBase = `${data.creator.id}/${data.screenshot.id}`;

    return Promise.resolve({
      blobThumbnail: `${blobNameBase}/thumbnail.jpg`,
      blobFhd: `${blobNameBase}/fhd.jpg`,
      blob4k: `${blobNameBase}/4k.jpg`
    });
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
  'batchUpdateEmbeddings' | 'deleteEmbedding'
> {
  public readonly embeddingUpdates: EmbeddingUpdate[] = [];

  public readonly embeddingDeletions: string[] = [];

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
}
