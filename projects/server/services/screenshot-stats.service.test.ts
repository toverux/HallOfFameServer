import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import type { Creator, Screenshot } from '#prisma-lib/client';
import { allFulfilled } from '../../shared/utils/all-fulfilled';
import { config } from '../config';
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

  describe('thresholds', () => {
    const {
      rankMinUniqueViews: minViews,
      rankMinFavorites: minFavorites,
      popularScreenshotsMinFavorites: popularMinFavorites
    } = config.screenshots;

    test(`computes the popular bar from the stored rates of screenshots with its minimum likes`, async () => {
      const [owner] = creators;

      // Ranked, but under the popular minimum likes.
      await createScreenshot(prisma, owner, {
        favoritesCount: popularMinFavorites - 1,
        uniqueViewsCount: 100,
        favoritingPercentage: 4
      });

      await createScreenshot(prisma, owner, {
        favoritesCount: popularMinFavorites,
        uniqueViewsCount: 0,
        favoritingPercentage: 40
      });

      await restart();

      expect(statsService.popularFavoritingPercentageThreshold).toBe(40);
      expect(ranks([3.9, 4])).toEqual(['bronze', 'diamond']);
    });

    test(`refreshes after the daily resync, from the resynced counters`, async () => {
      const [owner] = creators;

      const viewers = creators.slice(1);

      for (let i = viewers.length; i < minViews; i++) {
        // oxlint-disable-next-line no-await-in-loop - sequential factory numbering
        viewers.push(await createCreator(prisma));
      }

      // Stale counters the resync turns into 3 likes out of 30 unique viewers: 10%.
      const screenshot = await createScreenshot(prisma, owner, staleCounters);

      await allFulfilled(viewers.map(viewer => createView(prisma, screenshot, viewer)));

      await allFulfilled(
        viewers.slice(0, minFavorites).map(viewer => createFavorite(prisma, screenshot, viewer))
      );

      // Thresholds computed at startup from an empty population.
      expect(ranks([9.9, 10])).toEqual(['diamond', 'diamond']);
      expect(statsService.popularFavoritingPercentageThreshold).toBe(0);

      await statsService.resyncAllCron();

      expect(ranks([9.9, 10])).toEqual(['bronze', 'diamond']);
    });

    /**
     * Restarts the module, which computes the thresholds from the seeded screenshots.
     */
    async function restart(): Promise<void> {
      await testingModule.close();

      testingModule = await createServiceTestingModule([ScreenshotStatsService]);
      statsService = testingModule.get(ScreenshotStatsService);
      prisma = testingModule.get(PrismaService);
    }

    /**
     * Ranks screenshots with the given exact like rates, over 1000 unique viewers.
     */
    function ranks(likeRates: readonly number[]): Array<ReturnType<typeof statsService.getRank>> {
      return likeRates.map(likeRate =>
        statsService.getRank({ favoritesCount: likeRate * 10, uniqueViewsCount: 1000 })
      );
    }
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
