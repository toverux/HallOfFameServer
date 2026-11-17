import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import { type Document, MongoClient } from 'mongodb';
import { type Creator, Prisma, type Screenshot } from '#prisma-lib/client';
import { nn } from '../../../shared/utils/type-assertion';
import { config } from '../../config';
import { PrismaService } from '../../services/prisma.service';
import {
  createCreator,
  createCreatorActivity,
  createFavorite,
  createScreenshot,
  createUsageEvent,
  createView
} from '../../testing/factories';
import * as identifiers from '../../testing/identifiers';
import { createServiceTestingModule } from '../../testing/testing-module';
import { loadCards } from '../dashboard';
import { featureUsageDashboard } from './dashboard';
import { firstReleaseWithCompleteEvents } from './sessions';

const mongo = new MongoClient(config.databaseUrl);

const hourInMs = 60 * 60 * 1000;

const dayInMs = 24 * hourInMs;

const weekInMs = 7 * dayInMs;

const monday = new Date('2026-01-05T00:00:00Z');

// Outside the `9000` group createUsageEvent numbers its default session IDs in, so none collide.
const sessions = [
  '00000000-0000-4000-a000-000000000001',
  '00000000-0000-4000-a000-000000000002',
  '00000000-0000-4000-a000-000000000003',
  '00000000-0000-4000-a000-000000000004',
  '00000000-0000-4000-a000-000000000005'
] as const;

describe('Feature usage dashboard', () => {
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
    for (const { pipeline } of loadCards(featureUsageDashboard)) {
      // oxlint-disable-next-line unicorn/prefer-structured-clone - the JSON round trip is the point
      const serialized: unknown = JSON.parse(JSON.stringify(pipeline));

      expect(serialized).toStrictEqual(pipeline);
    }
  });

  describe('Feature adoption per week', () => {
    test(`shares the week's eligible players who touched each feature`, async () => {
      const [first, second, idle] = await seedPlayers(3);

      await seedEvent(first, sessions[0], 'context_entered', hoursAfterMonday(1));
      await seedEvent(first, sessions[0], 'slideshow_navigated', hoursAfterMonday(2));
      await seedEvent(first, sessions[0], 'slideshow_navigated', hoursAfterMonday(3));
      await seedEvent(second, sessions[1], 'context_entered', hoursAfterMonday(4));
      await seedEvent(second, sessions[1], 'capture_requested', hoursAfterMonday(5));

      // A like is a server row, tied to the session through its header.
      const screenshot = await createScreenshot(prisma, nn(idle));

      await createFavorite(prisma, screenshot, nn(second), { sessionId: sessions[1] });

      const rows = await runCard('Feature adoption per week');

      expect(rows.filter(row => row.share > 0)).toEqual([
        { week: monday, feature: 'Slideshow navigation', share: 1 / 3 },
        { week: monday, feature: 'Like', share: 1 / 3 },
        { week: monday, feature: 'Capture', share: 1 / 3 }
      ]);

      // Every feature has a point each week, so a line drops to zero rather than breaking.
      expect(rows.filter(row => row.share == 0).map(({ feature }) => feature as unknown)).toEqual([
        'More actions menu',
        'Screenshot details',
        'Creator dashboard',
        'Edit a screenshot',
        'Delete a screenshot',
        'Upload',
        'Save to disk',
        'Web viewer',
        'Mod page',
        'Social links'
      ]);
    });

    test(`counts only players whose mod sends usage events and who left them on`, async () => {
      const [player] = await seedPlayers(1);

      await seedEvent(player, sessions[0], 'context_entered', hoursAfterMonday(1));

      // Compared as integers: as strings, 2026.10.0 would sort below 2026.6.0.
      const versions = ['2026.10.0', '2026.6.0', '2027.1.0', '2026.5.12', Prisma.skip];

      for (const modVersion of versions) {
        // oxlint-disable-next-line no-await-in-loop - sequential factory numbering
        const creator = await createCreator(prisma);

        // oxlint-disable-next-line no-await-in-loop - sequential factory numbering
        await createCreatorActivity(prisma, creator, {
          lastSeenAt: hoursAfterMonday(2),
          modVersion
        });
      }

      // Switched usage statistics off after a session that sent events.
      const optedOut = await createCreator(prisma, { metadata: { sendUsageStatistics: false } });

      await createCreatorActivity(prisma, optedOut, {
        lastSeenAt: hoursAfterMonday(3),
        modVersion: '2026.6.1'
      });
      await seedEvent(optedOut, sessions[1], 'context_entered', hoursAfterMonday(3));

      expect(await shareOf('Launched the mod', 'Event coverage')).toEqual([
        { week: monday, share: 1 / 4 }
      ]);
    });

    test(`counts neither a debug session nor server rows of a session without events`, async () => {
      const [player, owner] = await seedPlayers(2);

      const screenshot = await createScreenshot(prisma, nn(owner));

      await seedEvent(player, sessions[0], 'context_entered', hoursAfterMonday(1));

      await createUsageEvent(prisma, nn(player), {
        sessionId: sessions[1],
        isDebug: true,
        name: 'context_entered',
        trackedAt: hoursAfterMonday(2)
      });
      await createFavorite(prisma, screenshot, nn(player), { sessionId: sessions[1] });
      await createFavorite(prisma, screenshot, nn(owner), { sessionId: sessions[2] });

      expect(await shareOf('Launched the mod', 'Event coverage')).toEqual([
        { week: monday, share: 1 / 2 }
      ]);
      expect(await shareOf('Like')).toEqual([{ week: monday, share: 0 }]);
    });

    async function shareOf(
      feature: string,
      card = 'Feature adoption per week'
    ): Promise<Document[]> {
      const rows = await runCard(card);

      return rows.filter(row => row.feature == feature).map(({ week, share }) => ({ week, share }));
    }
  });

  describe('Feature adoption, last week', () => {
    test(`ranks the features of the last ended week by share`, async () => {
      const lastWeek = new Date(weekStartOf(new Date()).getTime() - weekInMs);

      const [first, second] = await seedPlayers(2, lastWeek);

      await seedEvent(first, sessions[0], 'context_entered', lastWeek);
      await seedEvent(first, sessions[0], 'dashboard_opened', lastWeek);
      await seedEvent(second, sessions[1], 'context_entered', lastWeek);

      // The week before, and the week in progress.
      const weekBefore = new Date(lastWeek.getTime() - weekInMs);

      const [earlier] = await seedPlayers(1, weekBefore);
      const [current] = await seedPlayers(1, new Date());

      await seedEvent(earlier, sessions[2], 'more_actions_opened', weekBefore);
      await seedEvent(current, sessions[3], 'more_actions_opened', new Date());

      const rows = await runCard('Feature adoption, last week');

      expect(rows.slice(0, 2)).toEqual([
        { week: lastWeek, feature: 'Creator dashboard', share: 1 / 2 },
        { week: lastWeek, feature: expect.any(String), share: 0 }
      ]);
      // The launch baseline shows as Event coverage instead.
      expect(rows.map(row => row.feature as unknown)).not.toContain('Launched the mod');
      expect(rows).toHaveLength(13);
    });
  });

  describe('Capture funnel per week', () => {
    test(`sums each step over the sessions, each whole in the week it started`, async () => {
      const [player] = await seedPlayers(1);

      const steps = ['capture_requested', 'screenshot_captured', 'upload_started'];

      for (const name of [...steps, ...steps, 'capture_requested']) {
        // oxlint-disable-next-line no-await-in-loop - events in order
        await seedEvent(player, sessions[0], name, hoursAfterMonday(1));
      }

      // The session goes on past Sunday midnight.
      await seedEvent(player, sessions[0], 'upload_started', hoursAfterMonday(7 * 24 + 1));

      await seedStored(player, sessions[0], 3);

      // A debug session, then a session that sent no event, as with usage statistics off.
      await createUsageEvent(prisma, nn(player), {
        sessionId: sessions[1],
        isDebug: true,
        name: 'upload_started',
        trackedAt: hoursAfterMonday(2)
      });
      await seedStored(player, sessions[1], 1);
      await seedStored(player, sessions[2], 1);

      expect(await runCard('Capture funnel per week')).toEqual([
        { week: monday, step: 'Captures requested', count: 3 },
        { week: monday, step: 'Screenshots captured', count: 2 },
        { week: monday, step: 'Uploads started', count: 3 },
        { week: monday, step: 'Screenshots stored', count: 3 }
      ]);
    });
  });

  describe('Capture funnel, last week', () => {
    test(`draws the steps of the last ended week`, async () => {
      const lastWeek = new Date(weekStartOf(new Date()).getTime() - weekInMs);

      const [player] = await seedPlayers(1, lastWeek);

      await seedEvent(player, sessions[0], 'capture_requested', lastWeek);
      await seedEvent(player, sessions[0], 'screenshot_captured', lastWeek);
      await seedEvent(
        player,
        sessions[1],
        'capture_requested',
        new Date(lastWeek.getTime() - hourInMs)
      );

      expect(await runCard('Capture funnel, last week')).toEqual([
        { week: lastWeek, step: 'Captures requested', count: 1 },
        { week: lastWeek, step: 'Screenshots captured', count: 1 },
        { week: lastWeek, step: 'Uploads started', count: 0 },
        { week: lastWeek, step: 'Screenshots stored', count: 0 }
      ]);
    });
  });

  describe('Upload rate', () => {
    test(`divides the week's stored screenshots by its captured ones`, async () => {
      const [player] = await seedPlayers(1);

      for (const name of ['screenshot_captured', 'screenshot_captured', 'upload_started']) {
        // oxlint-disable-next-line no-await-in-loop - events in order
        await seedEvent(player, sessions[0], name, hoursAfterMonday(1));
      }

      await seedStored(player, sessions[0], 1);

      // A week without captures has no rate.
      await seedEvent(player, sessions[1], 'context_entered', hoursAfterMonday(7 * 24 + 1));

      expect(await runCard('Upload rate')).toEqual([
        { week: monday, uploadRate: 1 / 2 },
        { week: new Date(monday.getTime() + weekInMs), uploadRate: null }
      ]);
    });
  });

  describe('Upload outcomes per week', () => {
    test(`counts every started upload by outcome, the unlisted ones as Other error`, async () => {
      const [first, second] = await Array.fromAsync({ length: 2 }, () => createCreator(prisma));

      const outcomes = ['stored', 'stored', 'network', 'failed', 'cosmic_ray'];

      for (const outcome of outcomes) {
        // oxlint-disable-next-line no-await-in-loop - events in order
        await seedNewerEvent(first, sessions[0], 'upload_started');
        // oxlint-disable-next-line no-await-in-loop - events in order
        await seedNewerEvent(first, sessions[0], 'upload_finished', { properties: { outcome } });
      }

      // Two uploads started, one finished: the other reported no outcome.
      await seedNewerEvent(second, sessions[1], 'upload_started');
      await seedNewerEvent(second, sessions[1], 'upload_started');
      await seedNewerEvent(second, sessions[1], 'upload_finished', {
        properties: { outcome: 'rejected' }
      });

      // A finished upload whose start was lost does not take a missing outcome off another session.
      await seedNewerEvent(second, sessions[2], 'upload_finished', {
        properties: { outcome: 'encode_failed' }
      });

      expect(await runCard('Upload outcomes per week')).toEqual(
        outcomeRows(monday, [
          ['Stored', 2],
          ['Encoding failed', 1],
          ['Network error', 1],
          ['Unreadable response', 0],
          ['Refused', 1],
          ['Mod outdated', 0],
          ['Server error', 0],
          ['Other error', 2],
          ['No outcome reported', 1]
        ])
      );
    });

    test(`counts the sessions of the gating release or later, eligible or not`, async () => {
      const optedOut = await createCreator(prisma, { metadata: { sendUsageStatistics: false } });

      // No creator activity either, as the eligibility rule would require.
      const player = await createCreator(prisma);

      await seedStoredUpload(optedOut, sessions[0], {});

      // Compared as integers: as strings, 2026.10.0 would sort below the gate.
      await seedStoredUpload(player, sessions[1], { modVersion: '2026.10.0' });

      // An earlier release, then a debug build.
      await seedStoredUpload(player, sessions[2], { modVersion: '2026.7.0' });
      await seedStoredUpload(player, sessions[3], { isDebug: true });

      const rows = await runCard('Upload outcomes per week');

      expect(rows.find(row => row.outcome == 'Stored')).toEqual({
        week: monday,
        outcome: 'Stored',
        count: 2
      });
    });

    test(`counts a session whole in the week it started`, async () => {
      const player = await createCreator(prisma);

      await seedNewerEvent(player, sessions[0], 'upload_started');

      // The upload ends past Sunday midnight.
      await seedStoredUpload(player, sessions[0], { trackedAt: hoursAfterMonday(7 * 24 + 1) });

      // The week in progress.
      await seedStoredUpload(player, sessions[1], { trackedAt: new Date() });

      const rows = await runCard('Upload outcomes per week');

      expect(rows.filter(row => row.count > 0)).toEqual(
        outcomeRows(monday, [
          ['Stored', 1],
          ['No outcome reported', 1]
        ])
      );
    });

    /**
     * Seeds an upload started and stored in a session.
     */
    async function seedStoredUpload(
      creator: Creator | undefined,
      sessionId: string,
      overrides: Partial<Prisma.UsageEventUncheckedCreateInput>
    ): Promise<void> {
      await seedNewerEvent(creator, sessionId, 'upload_started', overrides);
      await seedNewerEvent(creator, sessionId, 'upload_finished', {
        ...overrides,
        properties: { outcome: 'stored' }
      });
    }
  });

  describe('Details window tabs per week', () => {
    test(`shares the openers who viewed each tab, opened on it or switched to`, async () => {
      const [first, second, third] = await Array.fromAsync({ length: 3 }, () =>
        createCreator(prisma)
      );

      const optedOut = await createCreator(prisma, { metadata: { sendUsageStatistics: false } });

      await seedOpened(first, sessions[0], 'description');
      await seedNewerEvent(first, sessions[0], 'screenshot_details_tab_changed', {
        properties: { tab: 'playset' }
      });

      // A player counts once however many sessions opened the tab.
      await seedOpened(second, sessions[1], 'description');
      await seedOpened(second, sessions[2], 'description');
      await seedOpened(second, sessions[2], 'photoModeSettings');

      // An opening on a tab outside the list still makes an opener.
      await seedOpened(third, sessions[3], 'comments');

      await seedOpened(optedOut, sessions[4], 'playset');

      // A week whose sessions opened no details window.
      await seedNewerEvent(first, identifiers.sessionId1, 'context_entered', {
        trackedAt: hoursAfterMonday(7 * 24 + 1)
      });

      const nextWeek = new Date(monday.getTime() + weekInMs);

      expect(await runCard('Details window tabs per week')).toEqual([
        { week: monday, tab: 'Description', share: 2 / 4 },
        { week: monday, tab: 'Photo mode settings', share: 1 / 4 },
        { week: monday, tab: 'Playset', share: 2 / 4 },
        { week: nextWeek, tab: 'Description', share: null },
        { week: nextWeek, tab: 'Photo mode settings', share: null },
        { week: nextWeek, tab: 'Playset', share: null }
      ]);
    });

    async function seedOpened(
      creator: Creator | undefined,
      sessionId: string,
      tab: string
    ): Promise<void> {
      await seedNewerEvent(creator, sessionId, 'screenshot_details_opened', {
        properties: { from: 'menu', tab }
      });
    }
  });

  describe('Menu tour outcomes per week', () => {
    test(`keys each tour's end by completed, then left menu, then step`, async () => {
      const player = await createCreator(prisma);

      const endings = [
        { completed: true, leftMenu: true, step: 'like' },
        { completed: false, leftMenu: true, step: 'navigation' },
        { completed: false, leftMenu: false, step: 'navigation' },
        { completed: false, leftMenu: false, step: 'navigation' },
        { completed: false, leftMenu: false, step: 'menuVisibility' },
        { completed: false, leftMenu: false, step: 'like' },
        // Closing the last balloon reports completed, so Dashboard keys no series.
        { completed: false, leftMenu: false, step: 'dashboard' }
      ];

      for (const properties of endings) {
        // oxlint-disable-next-line no-await-in-loop - events in order
        await seedNewerEvent(player, sessions[0], 'tour_started');
        // oxlint-disable-next-line no-await-in-loop - events in order
        await seedNewerEvent(player, sessions[0], 'tour_finished', { properties });
      }

      // A tour started with no reported end, and an end whose start was lost.
      await seedNewerEvent(player, sessions[1], 'tour_started');
      await seedNewerEvent(player, sessions[2], 'tour_finished', {
        properties: { completed: true, leftMenu: false, step: 'dashboard' }
      });

      expect(await runCard('Menu tour outcomes per week')).toEqual(
        outcomeRows(monday, [
          ['Completed', 2],
          ['Dismissed at Navigation', 2],
          ['Dismissed at Menu visibility', 1],
          ['Dismissed at Like', 1],
          ['Left the main menu', 1],
          ['No outcome reported', 1]
        ])
      );
    });
  });

  describe('Depth', () => {
    test(`counts sessions per eligible player, and views per session by session ID`, async () => {
      const [first, second] = await seedPlayers(3);

      const screenshot = await createScreenshot(prisma, nn(second));

      await seedEvent(first, sessions[0], 'context_entered', hoursAfterMonday(1));
      await seedViews(first, screenshot, sessions[0], 3);
      await seedEvent(first, sessions[1], 'context_entered', hoursAfterMonday(30));
      await seedViews(first, screenshot, sessions[1], 1);
      await seedEvent(second, sessions[2], 'context_entered', hoursAfterMonday(2));

      // A debug session, then a session that sent no event, as with usage statistics off.
      await createUsageEvent(prisma, nn(second), {
        sessionId: sessions[3],
        isDebug: true,
        trackedAt: hoursAfterMonday(3)
      });
      await seedViews(second, screenshot, sessions[3], 2);
      await seedViews(second, screenshot, sessions[4], 2);

      // The week in progress.
      await seedEvent(first, identifiers.sessionId1, 'context_entered', new Date());

      const row = { week: monday, players: 3, sessions: 3, views: 4 };

      expect(await runCard('Sessions per player per week')).toEqual([
        { ...row, sessionsPerPlayer: 1, viewsPerSession: 4 / 3 }
      ]);
    });

    test(`leaves out the sessions of a player who switched usage statistics off`, async () => {
      const [player, owner] = await seedPlayers(2);

      const screenshot = await createScreenshot(prisma, nn(owner));

      await seedEvent(player, sessions[0], 'context_entered', hoursAfterMonday(1));

      const optedOut = await createCreator(prisma, { metadata: { sendUsageStatistics: false } });

      await createCreatorActivity(prisma, optedOut, {
        lastSeenAt: hoursAfterMonday(2),
        modVersion: '2026.6.1'
      });
      await seedEvent(optedOut, sessions[1], 'context_entered', hoursAfterMonday(2));
      await seedViews(optedOut, screenshot, sessions[1], 2);

      expect(await runCard('Sessions per player per week')).toEqual([
        {
          week: monday,
          players: 2,
          sessions: 1,
          views: 0,
          sessionsPerPlayer: 1 / 2,
          viewsPerSession: 0
        }
      ]);
    });

    test.each([
      'Active players',
      'Sessions per player',
      'Active players per week',
      'Views per session per week'
    ])(`%s draws from the same rows`, async name => {
      const [player] = await seedPlayers(1);

      await seedEvent(player, sessions[0], 'context_entered', hoursAfterMonday(1));

      expect(await runCard(name)).toEqual([
        {
          week: monday,
          players: 1,
          sessions: 1,
          views: 0,
          sessionsPerPlayer: 1,
          viewsPerSession: 0
        }
      ]);
    });

    async function seedViews(
      viewer: Creator | undefined,
      screenshot: Screenshot,
      sessionId: string,
      count: number
    ): Promise<void> {
      for (let index = 0; index < count; index++) {
        // oxlint-disable-next-line no-await-in-loop - views in order
        await createView(prisma, screenshot, nn(viewer), {
          sessionId,
          viewedAt: hoursAfterMonday(1)
        });
      }
    }
  });

  /**
   * Creates screenshots the player uploaded during a session.
   */
  async function seedStored(
    player: Creator | undefined,
    uploadSessionId: string,
    count: number
  ): Promise<void> {
    for (let index = 0; index < count; index++) {
      // oxlint-disable-next-line no-await-in-loop - sequential factory numbering
      await createScreenshot(prisma, nn(player), { uploadSessionId });
    }
  }

  /**
   * Creates players who loaded the game, by default on Monday, with a mod version that sends usage
   * events.
   */
  async function seedPlayers(count: number, lastSeenAt = hoursAfterMonday(1)): Promise<Creator[]> {
    const players = await Array.fromAsync({ length: count }, () =>
      createCreator(prisma, { metadata: { sendUsageStatistics: true } })
    );

    for (const player of players) {
      // oxlint-disable-next-line no-await-in-loop - sequential factory numbering
      await createCreatorActivity(prisma, player, { lastSeenAt, modVersion: '2026.6.1' });
    }

    return players;
  }

  async function seedEvent(
    creator: Creator | undefined,
    sessionId: string,
    name: string,
    trackedAt: Date
  ): Promise<void> {
    await createUsageEvent(prisma, nn(creator), { sessionId, name, trackedAt });
  }

  /**
   * Creates an event sent on Monday by a mod release the outcome, tab, and tour cards count.
   */
  async function seedNewerEvent(
    creator: Creator | undefined,
    sessionId: string,
    name: string,
    overrides: Partial<Prisma.UsageEventUncheckedCreateInput> = {}
  ): Promise<void> {
    await createUsageEvent(prisma, nn(creator), {
      sessionId,
      name,
      modVersion: firstReleaseWithCompleteEvents,
      trackedAt: hoursAfterMonday(1),
      ...overrides
    });
  }

  async function runCard(name: string): Promise<Document[]> {
    const card = nn(loadCards(featureUsageDashboard).find(candidate => candidate.name == name));

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

/**
 * The rows of an outcome card's week, one per outcome in the given order.
 */
function outcomeRows(week: Date, counts: ReadonlyArray<readonly [string, number]>): Document[] {
  return counts.map(([outcome, count]) => ({ week, outcome, count }));
}

function hoursAfterMonday(hours: number): Date {
  return new Date(monday.getTime() + hours * hourInMs);
}

/**
 * The UTC Monday starting the week of a date.
 */
function weekStartOf(date: Date): Date {
  const day = Math.floor(date.getTime() / dayInMs) * dayInMs;

  // Sunday is 0, Monday 1.
  return new Date(day - ((new Date(day).getUTCDay() + 6) % 7) * dayInMs);
}
