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
import { nn } from '../../shared/utils/type-assertion';
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
 * They are computed using the deep-learning EfficientNet V2 TensorFlow model that extracts a
 * feature vector from an image. The feature vectors can be used to determine how close images are.
 *
 * To compare those vectors (arrays of 1280 floats), we use the USearch library, which uses a very
 * efficient Hierarchical Navigable Small Worlds (HNSW) implementation.
 */
@Injectable()
export class ScreenshotSimilarityDetectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScreenshotSimilarityDetectorService.name);

  private static readonly embeddingDimensions = 1280;

  /**
   * We cannot directly tell USearch to expand the search until a certain distance threshold is
   * reached, instead we have the limit of matches to return; this is the number of nearest
   * neighbors to return when searching for similar embeddings.
   * This should be a number large enough to make sure we return every relevant result, but not too
   * great to keep index search lightning fast.
   *
   * @see findPotentialDuplicates
   * @see findSimilarScreenshots
   */
  private static readonly kNearestNeighborsReturnCount = 100;

  /**
   * USearch index for embeddings.
   * @see https://unum-cloud.github.io/usearch
   */
  private readonly usearchIndex = LazyPromise.from(async () => {
    this.wasUsearchIndexRequired = true;

    const { index } = await this.buildUsearchIndex();

    return index;
  });

  /**
   * Whether {@link usearchIndex} was accessed, if not, operations that should update the index may
   * skip it to avoid an unnecessary index instantiation. Useful in CLI/server dev mode.
   */
  // biome-ignore lint/style/useReadonlyClassProperties: false positive
  private wasUsearchIndexRequired = false;

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(ScreenshotStorageService)
  private readonly screenshotStorage!: ScreenshotStorageService;

  /**
   * Inference worker for computing embeddings.
   * Lazily instantiated to avoid unnecessary instantiation in CLI/server dev mode.
   */
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
   * Marks that two screenshots that are being detected as similar are in fact different enough to
   * be kept.
   * They will then not be reported again by {@link findPotentialDuplicates}.
   */
  public async allowScreenshotSimilarity(
    firstId: Screenshot['id'],
    secondId: Screenshot['id']
  ): Promise<void> {
    const embeddings = await this.prisma.screenshotFeatureEmbedding.findMany({
      where: { screenshotId: { in: [firstId, secondId] } }
    });

    const firstEmbedding = nn(embeddings.find(embedding => embedding.screenshotId == firstId));
    const secondEmbedding = nn(embeddings.find(embedding => embedding.screenshotId == secondId));

    await this.prisma.$transaction([
      this.prisma.screenshotFeatureEmbedding.update({
        where: { id: firstEmbedding.id },
        data: { allowedSimilarityWithIds: { push: secondEmbedding.id } }
      }),
      this.prisma.screenshotFeatureEmbedding.update({
        where: { id: secondEmbedding.id },
        data: { allowedSimilarityWithIds: { push: firstEmbedding.id } }
      })
    ]);
  }

  /**
   * Finds pairs of similar screenshots based on precomputed embeddings and yields them along with
   * their similarity distance.
   * The comparison is performed by matching each embedding against every other embedding in the
   * dataset.
   * On a production dataset, the iterable will basically never end because there are so many
   * irrelevant matches past a certain distance threshold. This is more intended for moderation
   * purposes, where the first yielded pair will be the most suspiciously similar pair,
   * progressively yielding less and less similar pairs.
   * Until the human in the loop decides to stop because a certain similarity threshold has been
   * reached and cancels the process.
   *
   * @return An iterable that yields pairs of similar screenshots and their similarity distance.
   */
  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: very simple and sequential.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: necessary, but still easy to follow.
  public async *findPotentialDuplicates(): AsyncIterable<
    { screenshots: [Screenshot, Screenshot]; distance: number },
    void,
    undefined
  > {
    const { index, embeddings } = await this.buildUsearchIndex();

    this.logger.log(`Batch-matching all embeddings against the index...`);

    const vectors = embeddings.map(doc => new Float32Array(doc.embedding));

    // Match every embedding against every other embedding.
    const matches = index.search(
      vectors,
      ScreenshotSimilarityDetectorService.kNearestNeighborsReturnCount,
      0
    );

    // Since we're matching every embedding against every other embedding, two similar screenshots
    // A and B will yield two matches, [A, B] and [B, A].
    // Due to how the loop works with findMin() to find a match, [A, B] will always be directly
    // followed by [B, A].
    // Hence, when a match is yielded, we can entirely skip the next iteration.
    let skipNextRun = false;

    while (true) {
      // See the variable's comment.
      if (skipNextRun) {
        skipNextRun = false;
        continue;
      }

      // Find the smallest distance in all matches.
      const { index: distanceIndex, min: distance } = findMin(matches.distances);

      // We iterated over every match. This will never happen on a production dataset (way too much
      // data to ever see the end).
      if (distanceIndex < 0) {
        break;
      }

      // Neutralize the distance of the match we've explored so that we skip over it next loop.
      // We cannot simply remove the match as we would need to change other arrays (.keys, .counts),
      // making offset calculations and everything much more convoluted.
      matches.distances[distanceIndex] = Number.POSITIVE_INFINITY;

      // Find what embedding this match corresponds to.
      // embeddings[i] maps to matches.(keys|distances)[i*k..i*k+k].
      const embeddingIndex = Math.trunc(distanceIndex / matches.k);
      const embedding = nn(embeddings[embeddingIndex]);

      // Convert Uint64 index key to database hex ID.
      const matchingEmbeddingId = nn(matches.keys[distanceIndex]).toString(16).padStart(16, '0');

      // We matched against ourselves, this will happen once for every record (given 100% recall).
      if (matchingEmbeddingId == embedding.id) {
        continue;
      }

      // This match has already been handled by a human that marked it as okay.
      if (embedding.allowedSimilarityWithIds.includes(matchingEmbeddingId)) {
        continue;
      }

      // Retrieve screenshot document.
      // biome-ignore lint/performance/noAwaitInLoops: this is desired as part of the generator's logic.
      const screenshot = await this.prisma.screenshot.findUnique({
        where: { id: embedding.screenshotId }
      });

      // This screenshot was merged and deleted since the original scan was done.
      if (!screenshot) {
        continue;
      }

      // Retrieve matching screenshot document.
      const matchingEmbedding = await this.prisma.screenshotFeatureEmbedding.findUnique({
        where: { id: matchingEmbeddingId },
        select: { allowedSimilarityWithIds: true, screenshot: true }
      });

      // This screenshot was merged and deleted since the original scan was done.
      if (!matchingEmbedding) {
        continue;
      }

      // This match has already been handled by a human that marked it as okay.
      // This should be redundant with the previous check the other way around, but:
      // - it's safer to be explicit,
      // - if on the previous match images were not merged, only matchingEmbedding has an up-to-date
      //   list of allowedSimilarityWithIds.
      if (matchingEmbedding.allowedSimilarityWithIds.includes(embedding.id)) {
        continue;
      }

      // Different authors; consider them unrelated (they often are, they're just semantically close
      // for EfficientNet due to various common features).
      if (screenshot.creatorId != matchingEmbedding.screenshot.creatorId) {
        continue;
      }

      // See the variable's comment.
      skipNextRun = true;

      // Yield match and continue!
      yield { screenshots: [screenshot, matchingEmbedding.screenshot], distance };
    }

    function findMin(values: Float32Array): { index: number; min: number } {
      let index = -1;
      let min = Number.POSITIVE_INFINITY;

      for (let i = 0; i < values.length; i++) {
        // biome-ignore lint/style/noNonNullAssertion: cannot be null
        const value = values[i]!;

        if (value < min) {
          min = value;
          index = i;
        }
      }

      return { index, min };
    }
  }

  /**
   * Finds screenshots that are similar to a given screenshot based on their embeddings with a
   * specified maximum semantic distance.
   * The returned screenshots are sorted by similarity in descending order.
   *
   * @param screenshot  Object containing the `id` and `imageUrlFHD` properties of the screenshot to
   *                    find similarities for.
   * @param maxDistance The maximum allowable distance between embeddings for screenshots to be
   *                    considered similar.
   *
   * @return An array with all screenshot IDs and distances that match the given screenshot within
   *         the given maximum distance.
   */
  public async findSimilarScreenshots(
    screenshot: InputScreenshot,
    maxDistance: number
  ): Promise<Array<{ screenshotId: Screenshot['id']; distance: number }>> {
    // Load/retrieve the embedding for that screenshot.
    let embeddingDoc = await this.prisma.screenshotFeatureEmbedding.findUnique({
      where: { screenshotId: screenshot.id }
    });

    // Create embedding if it does not exist yet.
    if (!embeddingDoc) {
      const [newEmbeddingDoc] = await this.batchUpdateEmbeddings(screenshot.id, [screenshot]);

      embeddingDoc = nn(newEmbeddingDoc);
    }

    const index = await this.usearchIndex;

    const { keys, distances } = index.search(
      new Float32Array(embeddingDoc.embedding),
      ScreenshotSimilarityDetectorService.kNearestNeighborsReturnCount,
      0
    );

    // Note: keys are already sorted by distance, so keep that order.
    const embeddingIdsAndDistance = Array.from(keys)
      .map((key, index) => ({
        id: key.toString(16).padStart(16, '0'),
        distance: nn(distances[index])
      }))
      .filter(
        item =>
          // Skip match with our own embedding.
          // This is generally the first match, but not necessarily; ex. in the case the user uploaded
          // a 100% identical image (hence we don't use .splice()).
          item.id != embeddingDoc.id ||
          // Keep only matches with a distance below the maximum allowed.
          item.distance <= maxDistance
      );

    // Find all embeddings that were matched to get the screenshot IDs.
    const embeddingDocs = await this.prisma.screenshotFeatureEmbedding.findMany({
      where: { id: { in: embeddingIdsAndDistance.map(item => item.id) } },
      select: { id: true, screenshotId: true }
    });

    // Map (embedding ID, distance) to (screenshot ID, distance).
    return embeddingIdsAndDistance.map(item => ({
      screenshotId: nn(embeddingDocs.find(doc => doc.id == item.id)).screenshotId,
      distance: item.distance
    }));
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

      assert(embedding?.length == ScreenshotSimilarityDetectorService.embeddingDimensions);

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
      // Delete embedding from database.
      const embedding = await prisma.screenshotFeatureEmbedding.delete({
        where: { screenshotId }
      });

      // Find embeddings referencing this one through allowedSimilarityWithIds and remove the
      // connection.
      // Prisma does not do this automatically because we don't use an actual relation, see the
      // Prisma field's docblock for more info.
      const embeddingsReferencingThisOne = await prisma.screenshotFeatureEmbedding.findMany({
        where: { allowedSimilarityWithIds: { has: embedding.id } },
        select: { id: true, allowedSimilarityWithIds: true }
      });

      await allFulfilled(
        embeddingsReferencingThisOne.map(doc =>
          prisma.screenshotFeatureEmbedding.update({
            where: { id: doc.id },
            data: {
              allowedSimilarityWithIds: doc.allowedSimilarityWithIds.filter(
                id => id != embedding.id
              )
            }
          })
        )
      );

      // Remove embedding from index.
      if (this.wasUsearchIndexRequired) {
        const index = await this.usearchIndex;
        const key = BigInt(`0x${embedding.id}`);

        index.remove(key);
      }
    } catch (error) {
      // Ignore embedding not existing.
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
  private async buildUsearchIndex(): Promise<{
    index: Index;
    embeddings: ScreenshotFeatureEmbedding[];
  }> {
    this.logger.log('Loading embeddings...');

    const embeddingsDocs = await this.prisma.screenshotFeatureEmbedding.findMany();

    this.logger.log(`Building index for ${embeddingsDocs.length} embeddings...`);

    const flattenedEmbeddings = new Float32Array(
      embeddingsDocs.length * ScreenshotSimilarityDetectorService.embeddingDimensions
    );

    let offset = 0;

    for (const vector of embeddingsDocs.map(doc => doc.embedding)) {
      flattenedEmbeddings.set(vector, offset);
      offset += ScreenshotSimilarityDetectorService.embeddingDimensions;
    }

    const keys = embeddingsDocs.map(doc => BigInt(`0x${doc.id}`));

    const index = new usearch.Index(
      ScreenshotSimilarityDetectorService.embeddingDimensions,
      MetricKind.Cos
    );

    index.add(keys, flattenedEmbeddings);

    this.logger.log('Embeddings index ready.');

    return { index, embeddings: embeddingsDocs };
  }

  /**
   * Starts the inference worker to handle computational tasks.
   * Throws a top-level error whenever the worker encounters an error.
   */
  private spawnInferenceWorker(): Worker {
    const worker = new Worker(
      new URL('screenshot-similarity-detector.worker.ts', import.meta.url),
      // Use smol mode to consume less memory for the worker, we don't need a big heap of non-TF
      // stuff, so there is little to no impact on performance.
      { smol: true }
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
