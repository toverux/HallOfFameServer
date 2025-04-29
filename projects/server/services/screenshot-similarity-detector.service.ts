import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, Screenshot, ScreenshotFeatureEmbedding } from '@prisma/client';
import Bun from 'bun';
import PLazy from 'p-lazy';
import { Subject, first, firstValueFrom, timeout } from 'rxjs';
import usearch, { Index, MetricKind } from 'usearch';
import { allFulfilled } from '../common';
import { PrismaService } from './prisma.service';
import type { WorkerRequest, WorkerResponse } from './screenshot-similarity-detector.worker';
import { ScreenshotStorageService } from './screenshot-storage.service';

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
  private readonly usearchIndex = PLazy.from(() => this.buildUSearchIndex());

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(ScreenshotStorageService)
  private readonly screenshotStorage!: ScreenshotStorageService;

  private readonly workerResponses = new Subject<WorkerResponse>();

  private workerProcess!: Bun.Subprocess;

  private isWorkerProcessExiting = false;

  private lastWorkerMessageId = 0;

  public onModuleInit(): void {
    // noinspection JSUnusedGlobalSymbols
    this.workerProcess = Bun.spawn({
      cmd: [
        'bun',
        path.join(import.meta.dir, './screenshot-similarity-detector.worker.ts'),
        // Use bun --smol to consume less memory for the worker, we don't need a big heap for non-TF
        // stuff, so there is no significant impact on performance.
        '--smol'
      ],
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
      ipc: (message: WorkerResponse) => {
        this.workerResponses.next(message);
      },
      onExit: (_, exitCode) => {
        if (!this.isWorkerProcessExiting) {
          throw new Error(`Worker process unexpectedly exited with code ${exitCode}.`);
        }
      }
    });

    this.logger.log(`Inference worker process running (pid=${this.workerProcess.pid}).`);
  }

  public onModuleDestroy(): void {
    this.isWorkerProcessExiting = true;
    this.workerProcess.kill();
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
    screenshot: Pick<Screenshot, 'id' | 'imageUrlFHD'>,
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

    const { keys, distances } = index.search(new Float32Array(embeddingDoc.embedding), 20);

    for (let i = 0; i < keys.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: cannot be null.
      const key = keys[i]!;
      // biome-ignore lint/style/noNonNullAssertion: cannot be null.
      const distance = distances[i]!;

      if (distance > maxDistance || key == BigInt(`0x${embeddingDoc.id}`)) {
        continue;
      }

      const hexId = key.toString(16).padStart(16, '0');

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
    screenshots: readonly Pick<Screenshot, 'id' | 'imageUrlFHD'>[],
    prisma: Prisma.TransactionClient = this.prisma
  ): Promise<ScreenshotFeatureEmbedding[]> {
    const embeddings = await this.inferEmbedding(
      batchName,
      screenshots.map(screenshot => screenshot.imageUrlFHD)
    );

    const embeddingDocs: ScreenshotFeatureEmbedding[] = [];

    for (const screenshot of screenshots) {
      const embedding = embeddings.shift();

      assert(embedding?.length == this.embeddingDimensions);

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

      const index = await this.usearchIndex;
      const key = BigInt(`0x${embeddingDoc.id}`);

      index.remove(key);
      index.add(key, new Float32Array(embeddingDoc.embedding));
    }

    return embeddingDocs;
  }

  /**
   * Asynchronously builds a USearch index using embeddings retrieved from the database.
   *
   * The method retrieves embeddings from the database, flattens them into a single Float32Array,
   * and creates an index using the USearch library. The index is constructed based on the
   * specified embedding dimensions and the metric kind (Cosine similarity).
   */
  private async buildUSearchIndex(): Promise<Index> {
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
   * Generates embeddings (calling the inference worker) for the given set of image blob names.
   *
   * @param batchName A name for logging/debugging.
   * @param blobNames An array of blob names for which embeddings will be computed.
   *
   * @return A promise that resolves to a two-dimensional array of embeddings where each subarray
   *         corresponds to the embedding for a single image, the order mapping 1:1 to the input
   *         argument.
   */
  private async inferEmbedding(
    batchName: string,
    blobNames: readonly string[]
  ): Promise<number[][]> {
    this.logger.log(`Embedding batch ${batchName} of ${blobNames.length} image(s).`);

    const downloadStartTime = Date.now();

    const buffers = await allFulfilled(
      blobNames.map(name =>
        this.screenshotStorage
          .downloadScreenshotToBuffer(name)
          // To ArrayBuffer.
          .then(buffer => buffer.buffer as ArrayBuffer)
      )
    );

    this.logger.log(`Batch ${batchName} downloaded in ${Date.now() - downloadStartTime}ms.`);

    const inferenceStartTime = Date.now();

    const requestId = this.lastWorkerMessageId++;

    const request: WorkerRequest = {
      id: requestId,
      imagesData: buffers
    };

    this.workerProcess.send(request);

    const response = await firstValueFrom(
      this.workerResponses.pipe(
        first(message => message.id == requestId),
        timeout(60_000)
      )
    );

    if (response.payload instanceof Error) {
      throw response.payload;
    }

    assert(response.payload.length == blobNames.length);

    this.logger.log(
      `Batch ${batchName} embeddings generated in ${Date.now() - inferenceStartTime}ms.`
    );

    return response.payload;
  }
}
