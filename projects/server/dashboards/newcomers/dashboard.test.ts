import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import { type Document, MongoClient } from 'mongodb';
import type { TupleOf } from 'type-fest';
import { type Creator, Prisma, type Screenshot } from '#prisma-lib/client';
import { nn } from '../../../shared/utils/type-assertion';
import { config } from '../../config';
import { PrismaService } from '../../services/prisma.service';
import {
  createCreator,
  createCreatorActivity,
  createFavorite,
  createScreenshot,
  createView
} from '../../testing/factories';
import { createServiceTestingModule } from '../../testing/testing-module';
import { loadCards, type ShippedChange } from './dashboard';

const mongo = new MongoClient(config.databaseUrl);

const hourInMs = 60 * 60 * 1000;

const dayInMs = 24 * hourInMs;

const monday = new Date('2026-01-05T00:00:00Z');

/**
 * The smallest cohort the retention cards show.
 */
const minCohortSize = 30;

describe('Newcomers dashboard', () => {
  let testingModule: TestingModule;

  let prisma: PrismaService;

  beforeEach(async () => {
    testingModule = await createServiceTestingModule([]);
    prisma = testingModule.get(PrismaService);
  });

  afterEach(async () => {
    await testingModule.close();
  });

  afterAll(async () => {
    await mongo.close();
  });

  test(`builds every pipeline from JSON values, the body of a Metabase question`, () => {
    const cards = loadCards([{ date: '2026-01-07', label: 'A change' }]);

    for (const { pipeline } of cards) {
      // oxlint-disable-next-line unicorn/prefer-structured-clone - the JSON round trip is the point
      const serialized: unknown = JSON.parse(JSON.stringify(pipeline));

      expect(serialized).toStrictEqual(pipeline);
    }
  });

  describe('Cohort size', () => {
    test(`groups creators into UTC weeks starting on Monday, by account creation`, async () => {
      await createCreator(prisma, { createdAt: new Date('2026-01-04T23:59:00Z') });
      await createCreator(prisma, { createdAt: new Date('2026-01-05T00:00:00Z') });
      await createCreator(prisma, { createdAt: new Date('2026-01-11T23:59:00Z') });

      expect(await runCard('Cohort size')).toEqual([
        { week: new Date('2025-12-29T00:00:00Z'), period: 'baseline', creators: 1 },
        { week: new Date('2026-01-05T00:00:00Z'), period: 'baseline', creators: 2 }
      ]);
    });

    test(`leaves out a week until it has ended and its last member's first day is over`, async () => {
      const lastShownWeekEnd = weekStartOf(new Date(Date.now() - dayInMs));

      await createCreator(prisma, { createdAt: new Date(lastShownWeekEnd.getTime() - hourInMs) });
      // Joined last in their week, or first in the week in progress.
      await createCreator(prisma, { createdAt: lastShownWeekEnd });
      await createCreator(prisma, { createdAt: new Date() });

      expect(await runCard('Cohort size')).toEqual([
        {
          week: new Date(lastShownWeekEnd.getTime() - 7 * dayInMs),
          period: 'baseline',
          creators: 1
        }
      ]);
    });

    test(`starts with the first whole week of November 2024, after the launch weeks`, async () => {
      await createCreator(prisma, { createdAt: new Date('2024-11-03T23:59:00Z') });
      await createCreator(prisma, { createdAt: new Date('2024-11-04T00:00:00Z') });

      expect(await runCard('Cohort size')).toEqual([
        { week: new Date('2024-11-04T00:00:00Z'), period: 'baseline', creators: 1 }
      ]);
    });

    test(`splits a week straddling shipped changes into partial cohorts`, async () => {
      await createCreator(prisma, { createdAt: new Date('2026-01-05T10:00:00Z') });
      await createCreator(prisma, { createdAt: new Date('2026-01-07T11:59:00Z') });
      await createCreator(prisma, { createdAt: new Date('2026-01-07T12:00:00Z') });
      await createCreator(prisma, { createdAt: new Date('2026-01-09T00:00:00Z') });
      await createCreator(prisma, { createdAt: new Date('2026-01-14T00:00:00Z') });

      const week = new Date('2026-01-05T00:00:00Z');

      // Given out of order.
      const changes = [
        { date: '2026-01-09', label: 'Second change' },
        { date: '2026-01-07T12:00:00Z', label: 'First change' }
      ];

      expect(await runCard('Cohort size', changes)).toEqual([
        { week, period: 'baseline', creators: 2 },
        { week, period: 'since 2026-01-07 First change', creators: 1 },
        { week, period: 'since 2026-01-09 Second change', creators: 1 },
        {
          week: new Date('2026-01-12T00:00:00Z'),
          period: 'since 2026-01-09 Second change',
          creators: 1
        }
      ]);
    });
  });

  describe('Day-1 like rate', () => {
    test(`divides the cohort's likes by its views, both in the first 24 hours`, async () => {
      // Never viewed anything, so adds no view to divide by.
      const owner = await createCreator(prisma, { createdAt: monday });

      const [first, second, third, fourth] = await seedScreenshots(owner, 4);

      const liker = await createCreator(prisma, { createdAt: monday });

      await createView(prisma, first, liker, { viewedAt: hoursAfterMonday(1) });
      await createView(prisma, second, liker, { viewedAt: hoursAfterMonday(2) });
      await createView(prisma, third, liker, { viewedAt: hoursAfterMonday(23) });
      await createFavorite(prisma, first, liker, { favoritedAt: hoursAfterMonday(1) });
      // After the first 24 hours, so neither counts.
      await createView(prisma, fourth, liker, { viewedAt: hoursAfterMonday(24) });
      await createFavorite(prisma, fourth, liker, { favoritedAt: hoursAfterMonday(24) });

      const viewer = await createCreator(prisma, { createdAt: hoursAfterMonday(30) });

      await createView(prisma, first, viewer, { viewedAt: hoursAfterMonday(31) });
      // Before account creation, as a merged duplicate's records are, so neither counts.
      await createView(prisma, second, viewer, { viewedAt: hoursAfterMonday(29) });
      await createFavorite(prisma, second, viewer, { favoritedAt: hoursAfterMonday(29) });

      expect(await runCard('Day-1 like rate')).toEqual([
        { week: monday, period: 'baseline', creators: 3, likeRate: 0.25 }
      ]);
    });

    test(`leaves the rate empty for a cohort without views`, async () => {
      await createCreator(prisma, { createdAt: monday });

      expect(await runCard('Day-1 like rate')).toEqual([
        { week: monday, period: 'baseline', creators: 1, likeRate: null }
      ]);
    });
  });

  describe('Day-1 depth', () => {
    test(`takes the median of the members' views in the first 24 hours`, async () => {
      // Never viewed anything, so counts as 0 views.
      const owner = await createCreator(prisma, { createdAt: monday });

      const screenshots = await seedScreenshots(owner, 5);

      const [lightViewer, heavyViewer] = [
        await createCreator(prisma, { createdAt: monday }),
        await createCreator(prisma, { createdAt: monday })
      ];

      await Array.fromAsync(screenshots.slice(0, 2), screenshot =>
        createView(prisma, screenshot, lightViewer, { viewedAt: hoursAfterMonday(1) })
      );

      await Array.fromAsync(screenshots, screenshot =>
        createView(prisma, screenshot, heavyViewer, { viewedAt: hoursAfterMonday(1) })
      );

      // After the first 24 hours, so it doesn't count.
      await createView(prisma, screenshots[2], lightViewer, { viewedAt: hoursAfterMonday(24) });

      expect(await runCard('Day-1 depth')).toEqual([
        { week: monday, period: 'baseline', creators: 3, depth: 2 }
      ]);
    });
  });

  describe('Day-1 quality served', () => {
    test(`shares the first 24 hours' views on screenshots ranked Gold or better`, async () => {
      const owner = await createCreator(prisma, { createdAt: monday });

      // Like rates spreading the rankable screenshots over the ranks.
      const ranked = await Array.fromAsync([10, 10, 20, 20, 40, 40, 60, 60, 80, 80], rate =>
        createScreenshot(prisma, owner, { uniqueViewsCount: 100, favoritesCount: rate })
      );

      const [bottom, top] = [nn(ranked[0]), nn(ranked[9])];

      // The best like rate, but under the unique views floor.
      const unranked = await createScreenshot(prisma, owner, {
        uniqueViewsCount: 20,
        favoritesCount: 16
      });

      const viewer = await createCreator(prisma, { createdAt: monday });

      await createView(prisma, top, viewer, { viewedAt: hoursAfterMonday(1) });
      await createView(prisma, bottom, viewer, { viewedAt: hoursAfterMonday(2) });
      await createView(prisma, unranked, viewer, { viewedAt: hoursAfterMonday(3) });
      // After the first 24 hours, so it doesn't count.
      await createView(prisma, top, viewer, { viewedAt: hoursAfterMonday(24) });

      expect(await runCard('Day-1 quality served')).toEqual([
        { week: monday, period: 'baseline', creators: 2, qualityServed: 1 / 3 }
      ]);
    });
  });

  describe('Retention', () => {
    test(`shares the members active again in each window after creation`, async () => {
      // Never active, so retained in no window.
      const owner = await createCreator(prisma, { createdAt: monday });

      const [screenshot] = await seedScreenshots(owner, 1);

      // Joined at noon, so the end of their D1 window falls within a day of play.
      const dayPlayer = await createCreator(prisma, { createdAt: hoursAfterMonday(12) });

      const [dayViewer, weekPlayer, monthViewer, firstDayViewer, betweenViewer] =
        await Array.fromAsync({ length: minCohortSize - 2 }, () =>
          createCreator(prisma, { createdAt: monday })
        );

      await createView(prisma, screenshot, nn(dayViewer), { viewedAt: hoursAfterMonday(30) });
      // First seen on Wednesday before the end of the D1 window, last seen that day after it.
      await createCreatorActivity(prisma, dayPlayer, {
        firstSeenAt: hoursAfterMonday(58),
        lastSeenAt: hoursAfterMonday(62)
      });
      await createCreatorActivity(prisma, nn(weekPlayer), { lastSeenAt: daysAfterMonday(13) });
      await createView(prisma, screenshot, nn(monthViewer), { viewedAt: daysAfterMonday(30) });
      // Before the first window, then between the windows of D7 and D30.
      await createView(prisma, screenshot, nn(firstDayViewer), {
        viewedAt: hoursAfterMonday(23)
      });
      await createView(prisma, screenshot, nn(betweenViewer), { viewedAt: daysAfterMonday(14) });

      const cohort = { week: monday, period: 'baseline', creators: minCohortSize };

      expect(await runCard('D1 retention')).toEqual([{ ...cohort, d1: 2 / minCohortSize }]);
      expect(await runCard('D7 retention')).toEqual([{ ...cohort, d7: 1 / minCohortSize }]);
      expect(await runCard('D30 retention')).toEqual([{ ...cohort, d30: 1 / minCohortSize }]);
    });

    test.each(['D1 retention', 'D7 retention', 'D30 retention'])(
      `leaves out a cohort of fewer than 30 members (%s)`,
      async name => {
        await Array.fromAsync({ length: minCohortSize - 1 }, () =>
          createCreator(prisma, { createdAt: monday })
        );

        expect(await runCard(name)).toEqual([]);
      }
    );

    test(`leaves a retention empty until every member is past the end of its window`, async () => {
      // Joined last in the week before the last one shown, so between 8 and 16 days ago.
      const createdAt = new Date(
        weekStartOf(new Date(Date.now() - dayInMs)).getTime() - 7 * dayInMs - hourInMs
      );

      await Array.fromAsync({ length: minCohortSize }, () => createCreator(prisma, { createdAt }));

      const cohort = { week: weekStartOf(createdAt), period: 'baseline', creators: minCohortSize };

      expect(await runCard('D1 retention')).toEqual([{ ...cohort, d1: 0 }]);
      expect(await runCard('D30 retention')).toEqual([{ ...cohort, d30: null }]);
    });
  });

  describe('Day-1 newcomer picks', () => {
    test(`shares the first 24 hours' views labelled newcomer`, async () => {
      // Never viewed anything, so adds no view.
      const owner = await createCreator(prisma, { createdAt: monday });

      const [screenshot] = await seedScreenshots(owner, 1);

      const viewer = await createCreator(prisma, { createdAt: monday });

      await createView(prisma, screenshot, viewer, {
        viewedAt: hoursAfterMonday(1),
        algorithm: 'newcomer'
      });
      await createView(prisma, screenshot, viewer, {
        viewedAt: hoursAfterMonday(2),
        algorithm: 'random'
      });
      await createView(prisma, screenshot, viewer, { viewedAt: hoursAfterMonday(3) });
      await createView(prisma, screenshot, viewer, {
        viewedAt: hoursAfterMonday(4),
        algorithm: 'newcomer'
      });
      // After the first 24 hours, so it doesn't count.
      await createView(prisma, screenshot, viewer, {
        viewedAt: hoursAfterMonday(24),
        algorithm: 'newcomer'
      });

      expect(await runCard('Day-1 newcomer picks')).toEqual([
        { week: monday, period: 'baseline', creators: 2, newcomerShare: 0.5 }
      ]);
    });
  });

  describe('Daily actives', () => {
    test(`counts the creators who loaded the game each UTC day`, async () => {
      const [first, second] = await Array.fromAsync({ length: 2 }, () => createCreator(prisma));

      await createCreatorActivity(prisma, nn(first), { lastSeenAt: hoursAfterMonday(1) });
      await createCreatorActivity(prisma, nn(second), { lastSeenAt: hoursAfterMonday(23) });
      await createCreatorActivity(prisma, nn(first), { lastSeenAt: hoursAfterMonday(24) });

      expect(await runCard('Daily actives')).toEqual([
        { day: monday, period: 'baseline', creators: 2 },
        { day: daysAfterMonday(1), period: 'baseline', creators: 1 }
      ]);
    });

    test(`assigns each day the period it falls in`, async () => {
      const creator = await createCreator(prisma);

      await createCreatorActivity(prisma, creator, { lastSeenAt: hoursAfterMonday(23) });
      await createCreatorActivity(prisma, creator, { lastSeenAt: hoursAfterMonday(25) });

      const changes = [{ date: '2026-01-06', label: 'A change' }];

      expect(await runCard('Daily actives', changes)).toEqual([
        { day: monday, period: 'baseline', creators: 1 },
        { day: daysAfterMonday(1), period: 'since 2026-01-06 A change', creators: 1 }
      ]);
    });
  });

  describe('Daily actives (both cards)', () => {
    test.each(['Daily actives', 'Daily actives by mod version'])(
      `%s leaves out today, whose count is still growing`,
      async name => {
        const creator = await createCreator(prisma);

        const yesterday = new Date(Date.now() - dayInMs);

        await createCreatorActivity(prisma, creator, { lastSeenAt: yesterday });
        await createCreatorActivity(prisma, creator, { lastSeenAt: new Date() });

        const rows = await runCard(name);

        expect(rows.map(({ day }) => ({ day }))).toEqual([{ day: dayStartOf(yesterday) }]);
      }
    );
  });

  describe('Daily actives by mod version', () => {
    test(`splits the daily actives by the mod version they reported`, async () => {
      const creators = await Array.fromAsync({ length: 4 }, () => createCreator(prisma));

      const lastSeenAt = hoursAfterMonday(12);

      await createCreatorActivity(prisma, nn(creators[0]), { lastSeenAt, modVersion: '2026.5.0' });
      await createCreatorActivity(prisma, nn(creators[1]), { lastSeenAt, modVersion: '2026.5.0' });
      await createCreatorActivity(prisma, nn(creators[2]), { lastSeenAt, modVersion: '2026.4.1' });
      // Reported no version that day.
      await createCreatorActivity(prisma, nn(creators[3]), { lastSeenAt, modVersion: Prisma.skip });

      expect(await runCard('Daily actives by mod version')).toEqual([
        { day: monday, period: 'baseline', modVersion: '2026.4.1', creators: 1 },
        { day: monday, period: 'baseline', modVersion: '2026.5.0', creators: 2 },
        { day: monday, period: 'baseline', modVersion: 'unknown', creators: 1 }
      ]);
    });
  });

  describe('Like rate by algorithm', () => {
    test(`shares the labelled views whose creator liked the screenshot then or later`, async () => {
      const owner = await createCreator(prisma);

      const screenshots = await seedScreenshots(owner, 4);

      const [viewer, otherViewer] = await Array.fromAsync({ length: 2 }, () =>
        createCreator(prisma)
      );

      const viewedAt = hoursAfterMonday(1);

      // Liked at the view.
      await createView(prisma, screenshots[0], nn(viewer), { viewedAt, algorithm: 'random' });
      await createFavorite(prisma, screenshots[0], nn(viewer), { favoritedAt: viewedAt });
      // Liked later on.
      await createView(prisma, screenshots[1], nn(viewer), { viewedAt, algorithm: 'random' });
      await createFavorite(prisma, screenshots[1], nn(viewer), {
        favoritedAt: hoursAfterMonday(40)
      });
      // Liked before the view, so not after it.
      await createView(prisma, screenshots[2], nn(viewer), { viewedAt, algorithm: 'random' });
      await createFavorite(prisma, screenshots[2], nn(viewer), { favoritedAt: monday });
      await createView(prisma, screenshots[3], nn(viewer), { viewedAt, algorithm: 'trending' });
      // Unlabelled.
      await createView(prisma, screenshots[0], nn(viewer), { viewedAt });

      // The owner's like is not the other viewer's.
      await createView(prisma, screenshots[3], nn(otherViewer), {
        viewedAt: hoursAfterMonday(1),
        algorithm: 'trending'
      });
      await createFavorite(prisma, screenshots[3], owner, { favoritedAt: hoursAfterMonday(2) });

      expect(await runCard('Like rate by algorithm')).toEqual([
        {
          week: monday,
          period: 'baseline',
          algorithm: 'random',
          series: 'random, baseline',
          views: 3,
          likeRate: 2 / 3
        },
        {
          week: monday,
          period: 'baseline',
          algorithm: 'trending',
          series: 'trending, baseline',
          views: 2,
          likeRate: 0
        }
      ]);
    });

    test(`leaves out the week in progress, whose views had the least time to be liked`, async () => {
      const owner = await createCreator(prisma);

      const [screenshot] = await seedScreenshots(owner, 1);

      const viewer = await createCreator(prisma);

      const weekInProgress = weekStartOf(new Date());

      await createView(prisma, screenshot, viewer, {
        viewedAt: new Date(weekInProgress.getTime() - hourInMs),
        algorithm: 'random'
      });
      await createView(prisma, screenshot, viewer, {
        viewedAt: weekInProgress,
        algorithm: 'random'
      });

      const rows = await runCard('Like rate by algorithm');

      expect(rows.map(({ week, views }) => ({ week, views }))).toEqual([
        { week: new Date(weekInProgress.getTime() - 7 * dayInMs), views: 1 }
      ]);
    });

    test(`draws a series per algorithm and period, each view in the period it falls in`, async () => {
      const owner = await createCreator(prisma);

      const [screenshot] = await seedScreenshots(owner, 1);

      await createView(prisma, screenshot, owner, {
        viewedAt: hoursAfterMonday(23),
        algorithm: 'random'
      });
      await createView(prisma, screenshot, owner, {
        viewedAt: hoursAfterMonday(25),
        algorithm: 'random'
      });

      const changes = [{ date: '2026-01-06', label: 'A change' }];

      expect(await runCard('Like rate by algorithm', changes)).toEqual([
        {
          week: monday,
          period: 'baseline',
          algorithm: 'random',
          series: 'random, baseline',
          views: 1,
          likeRate: 0
        },
        {
          week: monday,
          period: 'since 2026-01-06 A change',
          algorithm: 'random',
          series: 'random, since 2026-01-06 A change',
          views: 1,
          likeRate: 0
        }
      ]);
    });
  });

  async function seedScreenshots<TCount extends number>(
    owner: Creator,
    count: TCount
  ): Promise<TupleOf<TCount, Screenshot>> {
    // The length is the count, which the compiler cannot tell from the array.
    return (await Array.fromAsync({ length: count }, () =>
      createScreenshot(prisma, owner)
    )) as TupleOf<TCount, Screenshot>;
  }

  async function runCard(
    name: string,
    changes: readonly ShippedChange[] = []
  ): Promise<Document[]> {
    const card = nn(loadCards(changes).find(candidate => candidate.name == name));

    const rows = await mongo
      .db()
      .collection(card.collection)
      .aggregate([...card.pipeline])
      .toArray();

    const columns = [...card.chart.dimensions, card.chart.metric];

    // Every row holds the columns its chart draws.
    for (const row of rows) {
      expect(columns.filter(column => !(column in row))).toEqual([]);
    }

    return rows;
  }
});

function hoursAfterMonday(hours: number): Date {
  return new Date(monday.getTime() + hours * hourInMs);
}

function daysAfterMonday(days: number): Date {
  return new Date(monday.getTime() + days * dayInMs);
}

function dayStartOf(date: Date): Date {
  return new Date(Math.floor(date.getTime() / dayInMs) * dayInMs);
}

/**
 * The UTC Monday starting the week of a date.
 */
function weekStartOf(date: Date): Date {
  const day = dayStartOf(date);

  // Sunday is 0, Monday 1.
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * dayInMs);
}
