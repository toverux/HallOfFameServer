import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type { Creator, Screenshot } from '#prisma-lib/client';
import { nn } from '../../shared/utils/type-assertion';
import { NotFoundByIdError } from '../common/standard-error';
import { createCreator, createFavorite, createScreenshot, createView } from '../testing/factories';
import {
  FakeAiTranslatorService,
  FakeScreenshotSimilarityDetectorService,
  FakeScreenshotStorageService
} from '../testing/fakes';
import * as identifiers from '../testing/identifiers';
import { createServiceTestingModule } from '../testing/testing-module';
import { AiTranslatorService } from './ai-translator.service';
import { BackgroundTasksService } from './background-tasks.service';
import { CreatorService } from './creator.service';
import { DateFnsLocalizationService } from './date-fns-localization.service';
import { FavoriteService } from './favorite.service';
import { ModService } from './mod.service';
import { PrismaService } from './prisma.service';
import { ScreenshotMergingService } from './screenshot-merging.service';
import { ScreenshotProcessingService } from './screenshot-processing.service';
import { ScreenshotSimilarityDetectorService } from './screenshot-similarity-detector.service';
import { ScreenshotStatsService } from './screenshot-stats.service';
import { ScreenshotStorageService } from './screenshot-storage.service';
import { ScreenshotService } from './screenshot.service';
import { ViewService } from './view.service';

const earlier = new Date('2026-02-01T09:00:00Z');

const later = new Date('2026-03-14T15:09:26Z');

const latest = new Date('2026-04-01T18:30:00Z');

describe('ScreenshotMergingService', () => {
  let testingModule: TestingModule;

  let mergingService: ScreenshotMergingService;

  let prisma: PrismaService;

  let screenshotStorage: FakeScreenshotStorageService;

  let screenshotSimilarityDetector: FakeScreenshotSimilarityDetectorService;

  let owner: Creator;

  let first: Creator;

  let second: Creator;

  let third: Creator;

  let target: Screenshot;

  let source: Screenshot;

  beforeEach(async () => {
    screenshotStorage = new FakeScreenshotStorageService();
    screenshotSimilarityDetector = new FakeScreenshotSimilarityDetectorService();

    testingModule = await createServiceTestingModule([
      ScreenshotMergingService,
      ScreenshotService,
      ScreenshotStatsService,
      BackgroundTasksService,
      CreatorService,
      DateFnsLocalizationService,
      FavoriteService,
      ModService,
      ScreenshotProcessingService,
      ViewService,
      { provide: AiTranslatorService, useValue: new FakeAiTranslatorService() },
      { provide: ScreenshotStorageService, useValue: screenshotStorage },
      { provide: ScreenshotSimilarityDetectorService, useValue: screenshotSimilarityDetector }
    ]);

    mergingService = testingModule.get(ScreenshotMergingService);
    prisma = testingModule.get(PrismaService);

    owner = await createCreator(prisma);
    first = await createCreator(prisma);
    second = await createCreator(prisma);
    third = await createCreator(prisma);

    target = await createScreenshot(prisma, owner);
    source = await createScreenshot(prisma, owner);
  });

  afterEach(async () => {
    await testingModule.close();
  });

  test(`moves the sources' likes and views to the target, then deletes the sources`, async () => {
    const otherSource = await createScreenshot(prisma, owner);

    await createFavorite(prisma, target, first);
    await createView(prisma, target, first);

    await createFavorite(prisma, source, second);
    await createView(prisma, source, second);

    await createView(prisma, otherSource, third);

    const result = await mergingService.mergeScreenshots(target.id, [source.id, otherSource.id]);

    expect(result).toEqual({
      mergedFavoritesCount: 2,
      deletedFavoritesCount: 0,
      mergedViewsCount: 3,
      deletedViewsCount: 0
    });

    expect(await likersOf(target)).toEqual([first.id, second.id]);
    expect(await viewersOf(target)).toEqual([first.id, second.id, third.id]);

    await testingModule.get(BackgroundTasksService).settled();

    const sourceIds = [source.id, otherSource.id].toSorted();

    expect(await prisma.screenshot.findMany({ where: { id: { in: sourceIds } } })).toEqual([]);

    expect(screenshotStorage.deletions.map(deleted => deleted.imageUrl4K).toSorted()).toEqual(
      [source.imageUrl4K, otherSource.imageUrl4K].toSorted()
    );

    expect(screenshotSimilarityDetector.embeddingDeletions.toSorted()).toEqual(sourceIds);
  });

  test(`resyncs the target's counters`, async () => {
    await createView(prisma, target, first);
    await createView(prisma, source, second);
    await createView(prisma, source, third);

    await createFavorite(prisma, source, second);

    await mergingService.mergeScreenshots(target.id, [source.id]);

    // 1 like out of 3 unique viewers.
    expect(await prisma.screenshot.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      viewsCount: 3,
      uniqueViewsCount: 3,
      favoritesCount: 1,
      favoritingPercentage: 33
    });
  });

  // The target's like, by the first creator, comes first and is the later one, so the date must
  // come from the source's, by the second creator but sharing one identifier with the first.
  // Rows build the shared identifier lazily, as the creators exist only once beforeEach ran.
  test.each([
    { shared: 'creator', sharing: () => ({ creatorId: first.id }) },
    { shared: 'hardware ID', sharing: () => ({ hwid: nn(first.hwids[0]) }) },
    { shared: 'IP', sharing: () => ({ ip: nn(first.ips[0]) }) }
  ])(`keeps one like per $shared, dated from the earliest`, async ({ sharing }) => {
    await createFavorite(prisma, target, first, { favoritedAt: later });

    await createFavorite(prisma, source, second, { ...sharing(), favoritedAt: earlier });

    const result = await mergingService.mergeScreenshots(target.id, [source.id]);

    expect(result).toMatchObject({ mergedFavoritesCount: 1, deletedFavoritesCount: 1 });

    expect(await prisma.favorite.findMany({ where: { screenshotId: target.id } })).toMatchObject([
      { favoritedAt: earlier }
    ]);
  });

  test(`keeps one view per creator, dated from the earliest`, async () => {
    await createView(prisma, target, first, { viewedAt: later });
    await createView(prisma, target, first, { viewedAt: latest });
    await createView(prisma, source, first, { viewedAt: earlier });
    await createView(prisma, source, second, { viewedAt: later });

    const result = await mergingService.mergeScreenshots(target.id, [source.id]);

    expect(result).toMatchObject({ mergedViewsCount: 2, deletedViewsCount: 2 });

    expect(
      await prisma.view.findMany({
        where: { screenshotId: target.id },
        select: { creatorId: true, viewedAt: true },
        orderBy: { viewedAt: 'asc' }
      })
    ).toEqual([
      { creatorId: first.id, viewedAt: earlier },
      { creatorId: second.id, viewedAt: later }
    ]);
  });

  test.each([
    {
      role: 'target',
      merge: () => mergingService.mergeScreenshots(identifiers.unknownScreenshotId, [source.id])
    },
    {
      role: 'source',
      merge: () =>
        mergingService.mergeScreenshots(target.id, [source.id, identifiers.unknownScreenshotId])
    }
  ])(`changes nothing, images included, for a missing $role`, async ({ merge }) => {
    await createFavorite(prisma, target, first);
    await createView(prisma, target, first);

    await createFavorite(prisma, source, second);
    await createView(prisma, source, second);

    expect(merge()).rejects.toThrow(new NotFoundByIdError(identifiers.unknownScreenshotId));

    expect(await prisma.screenshot.findUnique({ where: { id: source.id } })).not.toBeNull();

    expect(await likersOf(target)).toEqual([first.id]);
    expect(await viewersOf(target)).toEqual([first.id]);

    expect(await likersOf(source)).toEqual([second.id]);
    expect(await viewersOf(source)).toEqual([second.id]);

    expect(screenshotStorage.deletions).toEqual([]);
  });

  test(`keeps the images when the merge fails after deleting the sources`, async () => {
    await createFavorite(prisma, source, second);

    // The stats resync comes after the sources are deleted.
    spyOn(testingModule.get(ScreenshotStatsService), 'resyncStats').mockRejectedValue(
      new Error('The database is unavailable.')
    );

    expect(mergingService.mergeScreenshots(target.id, [source.id])).rejects.toThrow(
      'The database is unavailable.'
    );

    expect(await prisma.screenshot.findUnique({ where: { id: source.id } })).not.toBeNull();
    expect(await likersOf(source)).toEqual([second.id]);

    expect(screenshotStorage.deletions).toEqual([]);
  });

  test(`stands when deleting the images fails, logging the failure`, async () => {
    const logError = spyOn(Logger.prototype, 'error').mockReturnValue(void 0);

    spyOn(screenshotStorage, 'deleteScreenshots').mockRejectedValue(
      new Error('The storage is unavailable.')
    );

    await createFavorite(prisma, source, second);

    const result = await mergingService.mergeScreenshots(target.id, [source.id]);

    await testingModule.get(BackgroundTasksService).settled();

    expect(result).toMatchObject({ mergedFavoritesCount: 1 });

    expect(await prisma.screenshot.findUnique({ where: { id: source.id } })).toBeNull();
    expect(await likersOf(target)).toEqual([second.id]);

    expect(logError).toHaveBeenCalledWith(
      `Failed to delete the images of screenshot #${source.id} "${source.cityName}".`,
      expect.any(Error)
    );

    logError.mockRestore();
  });

  /**
   * IDs of the creators who liked the screenshot, in the order the creators were created.
   */
  async function likersOf(screenshot: Pick<Screenshot, 'id'>): Promise<string[]> {
    const favorites = await prisma.favorite.findMany({
      where: { screenshotId: screenshot.id },
      orderBy: { creatorId: 'asc' }
    });

    return favorites.map(favorite => favorite.creatorId);
  }

  /**
   * IDs of the creators who viewed the screenshot, in the order the creators were created.
   */
  async function viewersOf(screenshot: Pick<Screenshot, 'id'>): Promise<string[]> {
    const views = await prisma.view.findMany({
      where: { screenshotId: screenshot.id },
      orderBy: { creatorId: 'asc' }
    });

    return views.map(view => view.creatorId);
  }
});
