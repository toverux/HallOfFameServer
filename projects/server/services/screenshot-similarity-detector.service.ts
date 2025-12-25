import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit
} from '@nestjs/common';
import { oneLine } from 'common-tags';
import LazyPromise from 'p-lazy';
import { first, firstValueFrom, Subject, timeout } from 'rxjs';
import usearch, { type Index, MetricKind } from 'usearch';
import type { Prisma, Screenshot, ScreenshotFeatureEmbedding } from '#prisma-lib/client';
import { allFulfilled } from '../../shared/utils/all-fulfilled';
import { isPrismaError } from '../common/prisma-errors';
import { config } from '../config';
import { PrismaService } from './prisma.service';
import type { WorkerRequest, WorkerResponse } from './screenshot-similarity-detector.worker';
import { ScreenshotStorageService } from './screenshot-storage.service';

interface InputScreenshot {
  readonly id: Screenshot['id'];
  readonly imageUrlOrBuffer: Screenshot['imageUrlFHD'] | Uint8Array;
}

/**
 * Service for detecting similar screenshots based on their embeddings, extracted through a feature
 * vector model.
 *
 * Embeddings are stored in the database and are computed on the fly when needed.
 * They are computed using the deep-learning EfficientNet V2 TensorFlow model, that extracts a
 * feature vector from an image. The feature vectors can be used to determine how close images are.
 *
 * To compare those vectors (arrays of 1280 floats), we use the USearch library, which uses a very
 * efficient Hierarchical Navigable Small Worlds (HNSW) implementation.
 */
@Injectable()
export class ScreenshotSimilarityDetectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScreenshotSimilarityDetectorService.name);

  private readonly embeddingDimensions = 1280;

  /**
   * USearch index for embeddings.
   * @see https://unum-cloud.github.io/usearch
   */
  private readonly usearchIndex = LazyPromise.from(() => {
    this.wasUsearchIndexRequired = true;
    return this.buildUsearchIndex();
  });

  // biome-ignore lint/style/useReadonlyClassProperties: false positive
  private wasUsearchIndexRequired = false;

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(ScreenshotStorageService)
  private readonly screenshotStorage!: ScreenshotStorageService;

  private readonly inferenceWorker = LazyPromise.from(() => {
    this.maybeInferenceWorker = this.spawnInferenceWorker();
    return this.maybeInferenceWorker;
  });

  // biome-ignore lint/style/useReadonlyClassProperties: false positive
  private maybeInferenceWorker?: Worker;

  private readonly workerResponses = new Subject<WorkerResponse>();

  private lastWorkerMessageId = 0;

  public onModuleInit(): void {
    // In production (but not in CLI), trigger an immediate warmup of inference worker and USearch
    // index by then-ing the lazy promises.
    if (config.env == 'production' && config.runtimeType != 'cli') {
      this.inferenceWorker.then();
      this.usearchIndex.then();
    }
  }

  public onModuleDestroy(): void {
    this.maybeInferenceWorker?.terminate();
  }

  /**
   * Finds and yields screenshots that are similar to a given screenshot based on their embeddings,
   * and a specified maximum distance.
   *
   * @param screenshot  Object containing the `id` and `imageUrlFHD` properties of the screenshot to
   *                    find similarities for.
   * @param maxDistance The maximum allowable distance between embeddings for screenshots to be
   *                    considered similar.
   *
   * @return An asynchronous iterable yielding objects with properties `screenshotId` (ID of a
   *         similar screenshot) and `distance` (distance score indicating similarity, lower is
   *         closer).
   */
  public async *findSimilarScreenshots(
    screenshot: InputScreenshot,
    maxDistance: number
  ): AsyncIterable<{ screenshotId: Screenshot['id']; distance: number }, void, undefined> {
    // Load/retrieve the embedding for that screenshot.
    let embeddingDoc = await this.prisma.screenshotFeatureEmbedding.findUnique({
      where: { screenshotId: screenshot.id }
    });

    // Create embedding if it does not exist yet.
    if (!embeddingDoc) {
      const [newEmbeddingDoc] = await this.batchUpdateEmbeddings(screenshot.id, [screenshot]);
      assert(newEmbeddingDoc);

      embeddingDoc = newEmbeddingDoc;
    }

    const index = await this.usearchIndex;

    const { keys, distances } = index.search(new Float32Array(embeddingDoc.embedding), 20, 0);

    for (let i = 0; i < keys.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: cannot be null.
      const key = keys[i]!;
      // biome-ignore lint/style/noNonNullAssertion: cannot be null.
      const distance = distances[i]!;

      if (distance > maxDistance || key == BigInt(`0x${embeddingDoc.id}`)) {
        continue;
      }

      const hexId = key.toString(16).padStart(16, '0');

      // biome-ignore lint/performance/noAwaitInLoops: could be optimized, but not needed for now.
      const { screenshotId } = await this.prisma.screenshotFeatureEmbedding.findUniqueOrThrow({
        where: { id: hexId }
      });

      yield { screenshotId, distance };
    }
  }

  /**
   * Updates embeddings for the provided screenshots in batch by inferring embeddings from image
   * URLs and upserting the embeddings into the database.
   * Also updates the search index with the new embedding(s).
   */
  public async batchUpdateEmbeddings(
    batchName: string,
    screenshots: readonly InputScreenshot[],
    prisma: Prisma.TransactionClient = this.prisma
  ): Promise<ScreenshotFeatureEmbedding[]> {
    const embeddings = await this.inferEmbedding(batchName, screenshots);

    const embeddingDocs: ScreenshotFeatureEmbedding[] = [];

    for (const screenshot of screenshots) {
      const embedding = embeddings.shift();

      assert(embedding?.length == this.embeddingDimensions);

      // biome-ignore lint/performance/noAwaitInLoops: no need for this kind of performance in this method.
      const embeddingDoc = await prisma.screenshotFeatureEmbedding.upsert({
        where: { screenshotId: screenshot.id },
        create: {
          id: randomBytes(8).toString('hex'),
          screenshotId: screenshot.id,
          embedding
        },
        update: { embedding }
      });

      embeddingDocs.push(embeddingDoc);

      if (this.wasUsearchIndexRequired) {
        const index = await this.usearchIndex;
        const key = BigInt(`0x${embeddingDoc.id}`);

        index.remove(key);
        index.add(key, new Float32Array(embeddingDoc.embedding));
      }
    }

    return embeddingDocs;
  }

  /**
   * Deletes an embedding associated with the given screenshot ID from the database and removes it
   * from the USearch index.
   */
  public async deleteEmbedding(
    screenshotId: Screenshot['id'],
    prisma: Prisma.TransactionClient = this.prisma
  ): Promise<void> {
    try {
      const embedding = await prisma.screenshotFeatureEmbedding.delete({
        where: { screenshotId }
      });

      if (this.wasUsearchIndexRequired) {
        const index = await this.usearchIndex;
        const key = BigInt(`0x${embedding.id}`);

        index.remove(key);
      }
    } catch (error) {
      if (!(isPrismaError(error) && error.code == 'P2025')) {
        throw error;
      }
    }
  }

  /**
   * Asynchronously builds a USearch index using embeddings retrieved from the database.
   *
   * The method retrieves embeddings from the database, flattens them into a single Float32Array,
   * and creates an index using the USearch library. The index is constructed based on the
   * specified embedding dimensions and the metric kind (Cosine similarity).
   */
  private async buildUsearchIndex(): Promise<Index> {
    this.logger.log('Loading embeddings...');

    const docs = await this.prisma.screenshotFeatureEmbedding.findMany();

    this.logger.log(`Building index for ${docs.length} embeddings...`);

    const flattenedEmbeddings = new Float32Array(docs.length * this.embeddingDimensions);

    let offset = 0;

    for (const vector of docs.map(doc => doc.embedding)) {
      flattenedEmbeddings.set(vector, offset);
      offset += this.embeddingDimensions;
    }

    const keys = docs.map(doc => BigInt(`0x${doc.id}`));

    const index = new usearch.Index(this.embeddingDimensions, MetricKind.Cos);

    index.add(keys, flattenedEmbeddings);

    this.logger.log('Embeddings index ready.');

    return index;
  }

  /**
   * Starts the inference worker to handle computational tasks.
   * Throws a top-level error whenever the worker encounters an error.
   */
  private spawnInferenceWorker(): Worker {
    const worker = new Worker(
      new URL('screenshot-similarity-detector.worker.ts', import.meta.url),
      {
        // Use smol mode to consume less memory for the worker, we don't need a big heap for non-TF
        // stuff, so there is little to no impact on performance.
        smol: true
      }
    );

    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      this.workerResponses.next(event.data);
    });

    worker.addEventListener('error', event => {
      throw event.error ?? new Error(event.message);
    });

    this.logger.log(`Inference worker running.`);

    return worker;
  }

  /**
   * Generates embeddings (calling the inference worker) for the given set of image blob names.
   *
   * @param batchName   A name for logging/debugging.
   * @param screenshots An array of screenshots for which embeddings will be computed.
   *
   * @return A promise that resolves to a two-dimensional array of embeddings where each subarray
   *         corresponds to the embedding for a single image, the order mapping 1:1 to the input
   *         argument.
   */
  private async inferEmbedding(
    batchName: string,
    screenshots: readonly InputScreenshot[]
  ): Promise<number[][]> {
    this.logger.log(
      oneLine`
      Embedding ${screenshots.length == 1 ? 'image' : 'batch'} ${batchName}
      of ${screenshots.length} image(s).`
    );

    const downloadStartTime = Date.now();

    const buffers = await allFulfilled(
      screenshots.map(({ imageUrlOrBuffer }) =>
        typeof imageUrlOrBuffer == 'string'
          ? this.screenshotStorage.downloadScreenshotToBuffer(imageUrlOrBuffer)
          : Promise.resolve(imageUrlOrBuffer)
      )
    );

    this.logger.log(
      oneLine`
      ${screenshots.length == 1 ? 'Image' : 'Batch'} ${batchName} data acquired in
      ${Date.now() - downloadStartTime}ms.`
    );

    const inferenceStartTime = Date.now();

    const requestId = this.lastWorkerMessageId++;

    const request: WorkerRequest = {
      id: requestId,
      imagesData: buffers
    };

    (await this.inferenceWorker).postMessage(
      request,
      // Transfer ownership of underlying ArrayBuffers to the worker.
      buffers.map(buffer => buffer.buffer)
    );

    const response = await firstValueFrom(
      this.workerResponses.pipe(
        first(message => message.id == requestId),
        timeout(60_000)
      )
    );

    if (response.payload instanceof Error) {
      throw response.payload;
    }

    assert(response.payload.length == screenshots.length);

    this.logger.log(
      oneLine`
      ${screenshots.length == 1 ? 'Image' : 'Batch'} ${batchName} embeddings generated in
      ${Date.now() - inferenceStartTime}ms.`
    );

    return response.payload.map(buffer => Array.from(buffer));
  }
}
