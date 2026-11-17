import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import { type Document, MongoClient } from 'mongodb';
import type { Creator, Prisma } from '#prisma-lib/client';
import { config } from '../../config';
import { PrismaService } from '../../services/prisma.service';
import { runDashboardCard, weeksAgo } from '../../testing/dashboards';
import { createCreator, createUsageEvent } from '../../testing/factories';
import { createServiceTestingModule } from '../../testing/testing-module';
import { featureUsageDashboard } from './dashboard';

const mongo = new MongoClient(config.databaseUrl);

const minuteInMs = 60 * 1000;

// Outside the `9000` group createUsageEvent numbers its default session IDs in, so none collide.
const sessions = [
  '00000000-0000-4000-a000-000000000001',
  '00000000-0000-4000-a000-000000000002',
  '00000000-0000-4000-a000-000000000003',
  '00000000-0000-4000-a000-000000000004'
] as const;

describe('Feature usage dashboard, Ways in and main menu time', () => {
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

  describe('Where players open features, last 4 weeks', () => {
    test(`counts each player once per feature and place`, async () => {
      const first = await createCreator(prisma);

      const second = await createCreator(prisma);

      await seedEvent(first, 'dashboard_opened', { properties: { from: 'menu' } });
      await seedEvent(first, 'dashboard_opened', { properties: { from: 'menu' } });
      await seedEvent(second, 'dashboard_opened', { properties: { from: 'menu' } });
      await seedEvent(second, 'dashboard_opened', { properties: { from: 'upload_panel' } });
      await seedEvent(first, 'asset_mod_page_opened', { properties: { from: 'details' } });

      // A debug build, and an opening before the window.
      await seedEvent(first, 'viewer_opened', { isDebug: true, properties: { from: 'menu' } });
      await seedEvent(first, 'viewer_opened', {
        properties: { from: 'menu' },
        receivedAt: weeksAgo(5)
      });

      const rows = await runCard('Where players open features, last 4 weeks');

      expect(rows).toHaveLength(11);
      expect(rows.filter(row => row.players > 0)).toEqual([
        {
          entry: 'Dashboard, from the main menu',
          feature: 'Creator dashboard',
          players: 2
        },
        { entry: 'Dashboard, after an upload', feature: 'Creator dashboard', players: 1 },
        { entry: 'Mod page, from the details', feature: 'Mod page', players: 1 }
      ]);
    });
  });

  describe('Slideshow navigation inputs, last 4 weeks', () => {
    test(`shares the navigating players by the inputs they used`, async () => {
      const first = await createCreator(prisma);

      const second = await createCreator(prisma);

      await seedNavigation(first, { direction: 'next', via: 'button', device: 'keyboard_mouse' });
      await seedNavigation(first, { direction: 'previous', via: 'action', device: 'gamepad' });
      await seedNavigation(second, { direction: 'next', via: 'button', device: 'keyboard_mouse' });

      expect(await runCard('Slideshow navigation inputs, last 4 weeks')).toEqual([
        { input: 'On-screen buttons', share: 1 },
        { input: 'Key bindings', share: 1 / 2 },
        { input: 'A gamepad', share: 1 / 2 },
        { input: 'Went back a screenshot', share: 1 / 2 }
      ]);
    });

    async function seedNavigation(
      creator: Creator,
      properties: Prisma.InputJsonObject
    ): Promise<void> {
      await seedEvent(creator, 'slideshow_navigated', { properties });
    }
  });

  describe('main menu time', () => {
    test(`measures each session from its first main menu to its first city`, async () => {
      const player = await createCreator(prisma);

      // 2, 4, and 10 minutes, then a session that never loads a city.
      for (const [session, minutes] of [
        [sessions[0], 2],
        [sessions[1], 4],
        [sessions[2], 10]
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop - events in order
        await seedContext(player, session, 'MainMenu', 0);
        // oxlint-disable-next-line no-await-in-loop - events in order
        await seedContext(player, session, 'Game', minutes);
        // A return to the main menu and a second city leave the first ones.
        // oxlint-disable-next-line no-await-in-loop - events in order
        await seedContext(player, session, 'MainMenu', minutes + 30);
        // oxlint-disable-next-line no-await-in-loop - events in order
        await seedContext(player, session, 'Game', minutes + 40);
      }

      await seedContext(player, sessions[3], 'MainMenu', 0);

      const week = weeksAgo(1);

      const rows = await runCard('Time from main menu to city loaded, per week');

      expect(rows.map(row => row.quartile as unknown)).toEqual([
        '25th percentile',
        'Median',
        '75th percentile'
      ]);
      expect(rows.find(row => row.quartile == 'Median')).toEqual({
        week,
        quartile: 'Median',
        minutes: 4
      });

      expect(await runCard('Sessions that never load a city, per week')).toEqual([
        { week, sessionShare: 1 / 4 }
      ]);
    });

    async function seedContext(
      creator: Creator,
      sessionId: string,
      mode: string,
      minutes: number
    ): Promise<void> {
      const trackedAt = new Date(weeksAgo(1, 1).getTime() + minutes * minuteInMs);

      await createUsageEvent(prisma, creator, {
        sessionId,
        properties: { mode, purpose: mode == 'MainMenu' ? 'Cleanup' : 'LoadGame' },
        trackedAt
      });
    }
  });

  /**
   * Creates an event received last week, in a session of its own.
   */
  async function seedEvent(
    creator: Creator,
    name: string,
    overrides: Partial<Prisma.UsageEventUncheckedCreateInput> = {}
  ): Promise<void> {
    await createUsageEvent(prisma, creator, { name, trackedAt: weeksAgo(1, 1), ...overrides });
  }

  function runCard(name: string): Promise<Document[]> {
    return runDashboardCard(mongo, featureUsageDashboard, name);
  }
});
