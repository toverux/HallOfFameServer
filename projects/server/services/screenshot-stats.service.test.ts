import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import type { Creator, Screenshot } from '#prisma-lib/client';
import { createCreator, createFavorite, createScreenshot, createView } from '../testing/factories';
import { createServiceTestingModule } from '../testing/testing-module';
import { PrismaService } from './prisma.service';
import { ScreenshotStatsService } from './screenshot-stats.service';

// Counters left behind by likes and views that were since removed.
const staleCounters = {
  viewsCount: 99,
  uniqueViewsCount: 99,
  favoritesCount: 99,
  favoritingPercentage: 99
};

describe('ScreenshotStatsService', () => {
  let testingModule: TestingModule;

  let statsService: ScreenshotStatsService;

  let prisma: PrismaService;

  let creators: readonly [Creator, Creator, Creator, Creator];

  beforeEach(async () => {
    testingModule = await createServiceTestingModule([ScreenshotStatsService]);
    statsService = testingModule.get(ScreenshotStatsService);
    prisma = testingModule.get(PrismaService);

    creators = [
      await createCreator(prisma),
      await createCreator(prisma),
      await createCreator(prisma),
      await createCreator(prisma)
    ];
  });

  afterEach(async () => {
    await testingModule.close();
  });

  describe('resyncStats', () => {
    test(`recomputes the counters and the favoriting percentage`, async () => {
      const screenshot = await seedViewedAndLiked();

      await statsService.resyncStats();

      // 2 likes out of 3 unique viewers.
      expect(await counters(screenshot)).toEqual({
        viewsCount: 4,
        uniqueViewsCount: 3,
        favoritesCount: 2,
        favoritingPercentage: 67
      });
    });

    test(`sets a favoriting percentage of 0 when the screenshot has no views`, async () => {
      const [owner, liker] = creators;

      const screenshot = await createScreenshot(prisma, owner, staleCounters);

      await createFavorite(prisma, screenshot, liker);

      await statsService.resyncStats();

      expect(await counters(screenshot)).toEqual({
        viewsCount: 0,
        uniqueViewsCount: 0,
        favoritesCount: 1,
        favoritingPercentage: 0
      });
    });

    test(`zeroes the counters of a screenshot without views or likes`, async () => {
      const screenshot = await createScreenshot(prisma, creators[0], staleCounters);

      await statsService.resyncStats();

      expect(await counters(screenshot)).toEqual({
        viewsCount: 0,
        uniqueViewsCount: 0,
        favoritesCount: 0,
        favoritingPercentage: 0
      });
    });

    test(`resyncs only the screenshots it is given`, async () => {
      const screenshot = await seedViewedAndLiked();

      const other = await createScreenshot(prisma, creators[0], staleCounters);

      await statsService.resyncStats(new Set([screenshot.id]));

      expect(await counters(screenshot)).toMatchObject({ viewsCount: 4 });
      expect(await counters(other)).toEqual(staleCounters);
    });
  });

  describe('resyncRequestsCron', () => {
    test(`resyncs the screenshots requested since its last run, then forgets them`, async () => {
      const screenshot = await seedViewedAndLiked();

      const other = await createScreenshot(prisma, creators[0], staleCounters);

      statsService.requestStatsUpdate(screenshot.id);

      await statsService.resyncRequestsCron();

      expect(await counters(screenshot)).toMatchObject({ viewsCount: 4 });
      expect(await counters(other)).toEqual(staleCounters);

      await prisma.screenshot.update({ where: { id: screenshot.id }, data: staleCounters });

      await statsService.resyncRequestsCron();

      expect(await counters(screenshot)).toEqual(staleCounters);
    });
  });

  /**
   * A screenshot with stale counters, viewed 4 times by 3 creators, 2 of whom liked it.
   */
  async function seedViewedAndLiked(): Promise<Screenshot> {
    const [owner, first, second, third] = creators;

    const screenshot = await createScreenshot(prisma, owner, staleCounters);

    await createView(prisma, screenshot, first);
    await createView(prisma, screenshot, first);
    await createView(prisma, screenshot, second);
    await createView(prisma, screenshot, third);

    await createFavorite(prisma, screenshot, first);
    await createFavorite(prisma, screenshot, second);

    return screenshot;
  }

  function counters(
    screenshot: Pick<Screenshot, 'id'>
  ): Promise<
    Pick<Screenshot, 'viewsCount' | 'uniqueViewsCount' | 'favoritesCount' | 'favoritingPercentage'>
  > {
    return prisma.screenshot.findUniqueOrThrow({
      where: { id: screenshot.id },
      select: {
        viewsCount: true,
        uniqueViewsCount: true,
        favoritesCount: true,
        favoritingPercentage: true
      }
    });
  }
});
