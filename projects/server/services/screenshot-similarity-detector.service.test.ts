import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import { seconds } from '../../shared/utils/duration';
import {
  createCreator,
  createScreenshot,
  createScreenshotFeatureEmbedding
} from '../testing/factories';
import { FakeScreenshotStorageService } from '../testing/fakes';
import { createServiceTestingModule } from '../testing/testing-module';
import { PrismaService } from './prisma.service';
import { ScreenshotProcessingService } from './screenshot-processing.service';
import { ScreenshotSimilarityDetectorService } from './screenshot-similarity-detector.service';
import { ScreenshotStorageService } from './screenshot-storage.service';

// A Full HD JPEG.
const testImage = Bun.file(
  Bun.fileURLToPath(import.meta.resolve('../../shared/assets/healthcheck-test-image.jpg'))
);

describe('ScreenshotSimilarityDetectorService', () => {
  let testingModule: TestingModule;

  let similarityDetector: ScreenshotSimilarityDetectorService;

  let screenshotProcessing: ScreenshotProcessingService;

  let prisma: PrismaService;

  beforeEach(async () => {
    testingModule = await createServiceTestingModule([
      ScreenshotSimilarityDetectorService,
      ScreenshotProcessingService,
      { provide: ScreenshotStorageService, useValue: new FakeScreenshotStorageService() }
    ]);

    similarityDetector = testingModule.get(ScreenshotSimilarityDetectorService);
    screenshotProcessing = testingModule.get(ScreenshotProcessingService);
    prisma = testingModule.get(PrismaService);
  });

  afterEach(async () => {
    await testingModule.close();
  });

  // Runs the real inference worker and model on the buffers sharp produces on upload, in a batch as
  // the CLI sends them.
  // Loading the model takes seconds, hence the raised timeout.
  test(
    `stores an embedding for each image of a batch of sharp buffers`,
    async () => {
      const creator = await createCreator(prisma);
      const screenshots = [
        await createScreenshot(prisma, creator),
        await createScreenshot(prisma, creator)
      ];

      const imageData = Buffer.from(await testImage.arrayBuffer());

      const inputs = await Promise.all(
        screenshots.map(async screenshot => {
          const { imageFhdBuffer } = await screenshotProcessing.resizeScreenshots(imageData, {
            creatorName: undefined,
            cityName: screenshot.cityName
          });

          return { id: screenshot.id, imageUrlOrBuffer: imageFhdBuffer };
        })
      );

      await similarityDetector.batchUpdateEmbeddings('batch', inputs);

      const embeddings = await prisma.screenshotFeatureEmbedding.findMany({
        where: { screenshotId: { in: screenshots.map(screenshot => screenshot.id) } }
      });

      // EfficientNet V2's feature vector size.
      expect(embeddings.map(embedding => embedding.embedding.length)).toEqual([1280, 1280]);
    },
    seconds(60)
  );

  // Uploads store their embedding this way, as the search finds none for a new screenshot.
  test(
    `infers and stores the embedding of a screenshot that has none before searching`,
    async () => {
      const creator = await createCreator(prisma);
      const screenshot = await createScreenshot(prisma, creator);

      const { imageFhdBuffer } = await screenshotProcessing.resizeScreenshots(
        Buffer.from(await testImage.arrayBuffer()),
        { creatorName: undefined, cityName: screenshot.cityName }
      );

      expect(
        await similarityDetector.findSimilarScreenshots(
          { id: screenshot.id, imageUrlOrBuffer: imageFhdBuffer },
          0.1
        )
      ).toEqual([]);

      const embedding = await prisma.screenshotFeatureEmbedding.findUniqueOrThrow({
        where: { screenshotId: screenshot.id }
      });

      expect(embedding.embedding).toHaveLength(1280);
    },
    seconds(60)
  );

  // Another process (a CLI merge or delete) removes an embedding from the database but not from
  // this process's index, which keeps the stale key.
  test(`skips an index match whose embedding was deleted meanwhile`, async () => {
    const creator = await createCreator(prisma);
    const screenshot = await createScreenshot(prisma, creator);
    const neighbour = await createScreenshot(prisma, creator);

    await createScreenshotFeatureEmbedding(prisma, screenshot);
    await createScreenshotFeatureEmbedding(prisma, neighbour);

    const input = { id: screenshot.id, imageUrlOrBuffer: '' };

    // Builds the index while both embeddings exist.
    expect(await similarityDetector.findSimilarScreenshots(input, 0.1)).toEqual([
      { screenshotId: neighbour.id, distance: expect.any(Number) }
    ]);

    await prisma.screenshotFeatureEmbedding.delete({ where: { screenshotId: neighbour.id } });

    expect(await similarityDetector.findSimilarScreenshots(input, 0.1)).toEqual([]);
  });
});
