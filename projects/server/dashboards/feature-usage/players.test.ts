import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import { type Document, MongoClient } from 'mongodb';
import type { Creator, Prisma } from '#prisma-lib/client';
import { config } from '../../config';
import { PrismaService } from '../../services/prisma.service';
import { runDashboardCard, weeksAgo } from '../../testing/dashboards';
import {
  createCreator,
  createCreatorActivity,
  createFavorite,
  createScreenshot,
  createUsageEvent
} from '../../testing/factories';
import { createServiceTestingModule } from '../../testing/testing-module';
import { featureUsageDashboard } from './dashboard';

const mongo = new MongoClient(config.databaseUrl);

/**
 * Settings as the current mod reports them by default.
 */
const defaults = {
  enableMainMenuSlideshow: true,
  showViewCount: false,
  namesTranslationMode: 'translate',
  popularScreenshotWeight: 10,
  trendingScreenshotWeight: 10,
  recentScreenshotWeight: 10,
  archeologistScreenshotWeight: 0,
  randomScreenshotWeight: 5,
  supporterScreenshotWeight: 1,
  sendUsageStatistics: true
} as const;

describe('Feature usage dashboard, Players tab', () => {
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

  describe('Settings changed from their default, last 4 weeks', () => {
    test(`shares each setting's changers among the players whose mod reports it`, async () => {
      await seedPlayer({ ...defaults, showViewCount: true });
      await seedPlayer(defaults);

      // An older mod, which reports neither the usage statistics toggle nor Popular.
      const {
        sendUsageStatistics: _sendUsageStatistics,
        popularScreenshotWeight: _popular,
        ...older
      } = defaults;

      await seedPlayer({ ...older, enableMainMenuSlideshow: false });

      // Played before the window.
      await seedPlayer({ ...defaults, showViewCount: true }, weeksAgo(5));

      const shares = await sharesBySetting();

      expect(shares['Show view count']).toBe(1 / 3);
      expect(shares['Enable main menu integration']).toBe(1 / 3);
      expect(shares['Send usage statistics and error reports']).toBe(0);
      expect(shares['Weight: Popular']).toBe(0);
    });

    test(`counts the weights an earlier release shipped as defaults as unchanged`, async () => {
      // The defaults before 2026-01-17, and before 2025-05-10, Popular not reported yet.
      const { popularScreenshotWeight: _popular, ...withoutPopular } = defaults;

      await seedPlayer({
        ...defaults,
        recentScreenshotWeight: 5,
        archeologistScreenshotWeight: 2,
        randomScreenshotWeight: 2,
        supporterScreenshotWeight: 2
      });
      await seedPlayer({
        ...withoutPopular,
        recentScreenshotWeight: 5,
        archeologistScreenshotWeight: 5,
        randomScreenshotWeight: 2,
        supporterScreenshotWeight: 2
      });

      // One weight off the older defaults: the others still hold them, unchanged.
      await seedPlayer({
        ...defaults,
        recentScreenshotWeight: 5,
        archeologistScreenshotWeight: 2,
        randomScreenshotWeight: 2,
        supporterScreenshotWeight: 3
      });

      const shares = await sharesBySetting();

      expect(shares['Weight: Recent']).toBe(0);
      expect(shares['Weight: Forgotten Ones']).toBe(0);
      expect(shares['Weight: Random']).toBe(0);
      expect(shares['Weight: Community Supporters']).toBe(1 / 3);
      expect(shares['Weight: Popular']).toBe(0);
      expect(shares['Weight: Trending']).toBe(0);

      const rows = await runCard('Settings changed from their default, last 4 weeks');

      // Most changed first.
      expect(rows.map(row => row.share as number)).toEqual(
        rows.map(row => row.share as number).toSorted((a, b) => b - a)
      );
    });

    async function sharesBySetting(): Promise<Record<string, unknown>> {
      const rows = await runCard('Settings changed from their default, last 4 weeks');

      return Object.fromEntries(rows.map(row => [String(row.setting), row.share as unknown]));
    }
  });

  describe('Changed any setting', () => {
    test(`shares the players with any setting changed, overall and by account age`, async () => {
      await seedPlayer({ ...defaults, viewMaxAge: 30 }, weeksAgo(1), {
        createdAt: weeksAgo(60)
      });
      await seedPlayer(defaults, weeksAgo(1), { createdAt: weeksAgo(60) });
      await seedPlayer(defaults, weeksAgo(1), { createdAt: weeksAgo(2) });

      expect(await runCard('Changed any setting')).toEqual([{ share: 1 / 3 }]);

      expect(await runCard('Changed any setting, by account age')).toEqual([
        { accountAge: 'Joined in the last 4 weeks', share: 0 },
        { accountAge: 'Over a year', share: 1 / 2 }
      ]);
    });
  });

  describe('Slideshow weights changed, last 4 weeks', () => {
    test(`counts each weight off its default as raised, lowered, or turned off`, async () => {
      await seedPlayer({
        ...defaults,
        archeologistScreenshotWeight: 3,
        recentScreenshotWeight: 4,
        randomScreenshotWeight: 0
      });
      await seedPlayer({ ...defaults, recentScreenshotWeight: 0 });

      // The defaults of an earlier release, untouched.
      await seedPlayer({
        ...defaults,
        recentScreenshotWeight: 5,
        archeologistScreenshotWeight: 2,
        randomScreenshotWeight: 2,
        supporterScreenshotWeight: 2
      });

      // The same, then Forgotten Ones raised and Random turned off: Recent and Community Supporters
      // still hold their old defaults, neither lowered nor raised.
      await seedPlayer({
        ...defaults,
        recentScreenshotWeight: 5,
        archeologistScreenshotWeight: 4,
        randomScreenshotWeight: 0,
        supporterScreenshotWeight: 2
      });

      expect(await runCard('Slideshow weights changed, last 4 weeks')).toEqual([
        { algorithm: 'Recent', direction: 'Lowered', players: 1 },
        { algorithm: 'Recent', direction: 'Turned off', players: 1 },
        { algorithm: 'Forgotten Ones', direction: 'Raised', players: 2 },
        { algorithm: 'Random', direction: 'Turned off', players: 2 }
      ]);
    });
  });

  describe('Screens and capture resolution, last 4 weeks', () => {
    test(`counts the players by screen class and screenshot resolution`, async () => {
      const screens = [
        [1920, 1080, 'fhd'],
        [1920, 1200, 'fhd'],
        [2560, 1440, '4k'],
        [3440, 1440, '4k'],
        [3840, 2160, '4k'],
        [2560, 1440, '4k']
      ] as const;

      for (const [screenWidth, screenHeight, screenshotResolution] of screens) {
        // oxlint-disable-next-line no-await-in-loop - sequential factory numbering
        await seedPlayer({ screenWidth, screenHeight, screenshotResolution });
      }

      // A mod that reports no screen.
      await seedPlayer({ screenshotResolution: 'fhd' });

      expect(await runCard('Screens and capture resolution, last 4 weeks')).toEqual([
        { screen: 'Up to 1080p', resolution: 'Full HD screenshots', players: 1 },
        { screen: 'Above 1080p, below 4K', resolution: 'Full HD screenshots', players: 1 },
        { screen: 'Above 1080p, below 4K', resolution: '4K screenshots', players: 2 },
        { screen: 'Ultrawide', resolution: '4K screenshots', players: 1 },
        { screen: '4K or more', resolution: '4K screenshots', players: 1 }
      ]);
    });
  });

  describe('headline numbers', () => {
    test(`count the window's players and share them by what their metadata reports`, async () => {
      const uploader = await seedPlayer({
        sendUsageStatistics: false,
        useLegacyInterface: true,
        isGamepadConnected: false
      });

      await seedPlayer({ sendUsageStatistics: true, useLegacyInterface: false });
      await seedPlayer({});

      await createScreenshot(prisma, uploader);

      expect(await runCard('Players counted, last 4 weeks')).toEqual([{ players: 3 }]);
      expect(await runCard('Ever uploaded')).toEqual([{ share: 1 / 3 }]);
      expect(await runCard('Usage statistics switched off')).toEqual([{ share: 1 / 2 }]);
      expect(await runCard('Legacy interface')).toEqual([{ share: 1 / 2 }]);
      expect(await runCard('Gamepad connected')).toEqual([{ share: 0 }]);
    });
  });

  describe('Engagement by game language, last 4 weeks', () => {
    test(`shares the players who sent events by what they did, per language`, async () => {
      const english = await createCreator(prisma, { locale: 'en-US' });
      const englishIdle = await createCreator(prisma, { locale: 'en-US' });
      const chinese = await createCreator(prisma, { locale: 'zh-HANS' });
      const german = await createCreator(prisma, { locale: 'de-DE' });

      for (const player of [english, englishIdle, chinese, german]) {
        // oxlint-disable-next-line no-await-in-loop - sequential factory numbering
        await seedEvent(player, 'context_entered');
      }

      await seedEvent(english, 'slideshow_navigated');

      const screenshot = await createScreenshot(prisma, german, { createdAt: weeksAgo(1, 2) });

      await createFavorite(prisma, screenshot, chinese, { favoritedAt: weeksAgo(1, 3) });

      // A like before the window, and a player who sent no event.
      await createFavorite(prisma, screenshot, english, { favoritedAt: weeksAgo(6) });

      const silent = await createCreator(prisma, { locale: 'en-US' });

      await createFavorite(prisma, screenshot, silent, { favoritedAt: weeksAgo(1, 3) });

      expect(await runCard('Engagement by game language, last 4 weeks')).toEqual([
        ...engagementRows('English, 2 players', [0, 1 / 2, 0]),
        ...engagementRows('Chinese (Simplified), 1 players', [1, 0, 0]),
        ...engagementRows('Other languages, 1 players', [0, 0, 1])
      ]);
    });

    function engagementRows(
      language: string,
      [liked, navigated, uploaded]: readonly [number, number, number]
    ): Document[] {
      return [
        { language, engagement: 'Liked a screenshot', share: liked },
        { language, engagement: 'Navigated the slideshow', share: navigated },
        { language, engagement: 'Uploaded a screenshot', share: uploaded }
      ];
    }

    async function seedEvent(creator: Creator, name: string): Promise<void> {
      await createUsageEvent(prisma, creator, { name, trackedAt: weeksAgo(1, 1) });
    }
  });

  /**
   * Creates a player who loaded the game, by default last week, whose mod last reported the given
   * metadata.
   */
  async function seedPlayer(
    metadata: Prisma.InputJsonObject,
    lastSeenAt = weeksAgo(1, 1),
    overrides: Readonly<{ createdAt?: Date }> = {}
  ): Promise<Creator> {
    const player = await createCreator(prisma, { metadata, ...overrides });

    await createCreatorActivity(prisma, player, { lastSeenAt });

    return player;
  }

  function runCard(name: string): Promise<Document[]> {
    return runDashboardCard(mongo, featureUsageDashboard, name);
  }
});
