import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import { type Document, MongoClient } from 'mongodb';
import type { Creator, Prisma } from '#prisma-lib/client';
import { nn } from '../../../shared/utils/type-assertion';
import { config } from '../../config';
import { PrismaService } from '../../services/prisma.service';
import { runDashboardCard, weeksAgo } from '../../testing/dashboards';
import { createCreator, createScreenshot } from '../../testing/factories';
import { createServiceTestingModule } from '../../testing/testing-module';
import { featureUsageDashboard } from './dashboard';

const mongo = new MongoClient(config.databaseUrl);

/**
 * Capture conditions as the mod records them, keys holding dots.
 */
const conditions = {
  'light.dayPhase': 'Day',
  'climate.season': 'SeasonSummer',
  'climate.weather': 'Clear',
  'city.theme': 'European',
  'time.isOverridden': false,
  'capture.isDynamicResolutionForcedOff': false
} as const;

describe('Feature usage dashboard, Uploads tab', () => {
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

  test(`the headline numbers compare last week with the week before`, async () => {
    const [first, second] = await seedCreators(2);

    await seedUpload(first, { createdAt: weeksAgo(2, 1) });
    await seedUpload(first, { createdAt: weeksAgo(1, 1) });
    await seedUpload(first, { createdAt: weeksAgo(1, 2) });
    await seedUpload(second, { createdAt: weeksAgo(1, 3) });

    // The week in progress.
    await seedUpload(second, { createdAt: new Date() });

    // An upload before the two weeks.
    await seedUpload(second, { createdAt: weeksAgo(8) });

    const rows = [
      { week: weeksAgo(2), uploads: 1, uploaders: 1, firstTimeUploaders: 1, uploadsPerUploader: 1 },
      {
        week: weeksAgo(1),
        uploads: 3,
        uploaders: 2,
        firstTimeUploaders: 0,
        uploadsPerUploader: 3 / 2
      }
    ];

    for (const name of ['Uploads', 'Uploaders', 'First-time uploaders', 'Uploads per uploader']) {
      // oxlint-disable-next-line no-await-in-loop - one card after the other
      expect(await runCard(name)).toEqual(rows);
    }
  });

  describe('Uploaders per week', () => {
    test(`splits the week's uploaders by whether their first upload ever fell in it`, async () => {
      const [veteran, newcomer] = await seedCreators(2);

      // Before the series' 26 weeks.
      await seedUpload(veteran, { createdAt: weeksAgo(40) });
      await seedUpload(veteran, { createdAt: weeksAgo(1, 1) });
      await seedUpload(newcomer, { createdAt: weeksAgo(2, 1) });
      await seedUpload(newcomer, { createdAt: weeksAgo(1, 1) });

      expect(await runCard('Uploaders per week')).toEqual([
        { week: weeksAgo(2), kind: 'First upload', uploaders: 1 },
        { week: weeksAgo(1), kind: 'Returning uploader', uploaders: 2 }
      ]);
    });
  });

  describe('Upload form choices, per 4 weeks', () => {
    test(`shares each period's uploaders who made each choice on any upload`, async () => {
      const [first, second] = await seedCreators(2);

      await seedUpload(first, { createdAt: weeksAgo(1, 1), description: 'Harbour at dusk' });
      await seedUpload(first, { createdAt: weeksAgo(2, 1), shareParadoxModIds: false });
      await seedUpload(second, { createdAt: weeksAgo(3, 1), showcasedModId: 74_417 });

      // A blank description, and an upload of the period before.
      await seedUpload(second, { createdAt: weeksAgo(4, 1), description: '  ' });
      await seedUpload(second, { createdAt: weeksAgo(5, 1), shareRenderSettings: false });

      const rows = await runCard('Upload form choices, per 4 weeks');

      const lastPeriod = rows.filter(
        row => (row.period as Date).getTime() == weeksAgo(4).getTime()
      );

      expect(lastPeriod).toEqual([
        { period: weeksAgo(4), choice: 'Wrote a description', uploaderShare: 1 / 2 },
        { period: weeksAgo(4), choice: 'Showcased an asset', uploaderShare: 1 / 2 },
        { period: weeksAgo(4), choice: 'Hid their playset', uploaderShare: 1 / 2 },
        { period: weeksAgo(4), choice: 'Hid photo mode settings', uploaderShare: 0 }
      ]);

      // The period before holds the upload that hid them.
      expect(rows.filter(row => row.choice == 'Hid photo mode settings')).toEqual([
        { period: weeksAgo(8), choice: 'Hid photo mode settings', uploaderShare: 1 },
        { period: weeksAgo(4), choice: 'Hid photo mode settings', uploaderShare: 0 }
      ]);
    });
  });

  describe('Photo mode settings changed, last 12 weeks', () => {
    test(`shares the sharing uploaders by family, then those who changed none`, async () => {
      const [first, second, third] = await seedCreators(3);

      await seedUpload(first, {
        renderSettings: {
          'Time of Day': 13.5,
          'PhotoModeRenderSystem.focalLength': 35,
          'ColorAdjustments.contrast': 10,
          'ColorAdjustments.colorFilter/r': 0.9
        }
      });
      await seedUpload(first, { renderSettings: {} });
      await seedUpload(second, { renderSettings: { 'ColorAdjustments.saturation': 5 } });
      await seedUpload(third, { renderSettings: {} });

      // Not shared.
      await seedUpload(third, {
        shareRenderSettings: false,
        renderSettings: { 'DepthOfField.focusMode': 1 }
      });

      expect(await runCard('Photo mode settings changed, last 12 weeks')).toEqual([
        { setting: 'Color adjustments', kind: 'Changed', uploaderShare: 2 / 3 },
        { setting: 'Focal length', kind: 'Changed', uploaderShare: 1 / 3 },
        { setting: 'Time of day', kind: 'Changed', uploaderShare: 1 / 3 },
        { setting: 'Nothing changed', kind: 'Nothing changed', uploaderShare: 1 / 3 }
      ]);
    });
  });

  describe('captures', () => {
    test(`share the uploads by each aspect of their scene, an unlisted value as Other`, async () => {
      const [player] = await seedCreators(1);

      await seedUpload(player, { renderConditions: conditions });
      await seedUpload(player, {
        renderConditions: {
          ...conditions,
          'light.dayPhase': 'Night',
          'climate.weather': 'Overcast',
          'city.theme': 'nem-Japanese',
          'time.isOverridden': true
        }
      });

      // Recorded before the mod read the scene.
      await seedUpload(player, { renderConditions: {} });

      expect(await runCard('Time of day of uploads, last 12 weeks')).toEqual([
        { dayPhase: 'Day', uploadShare: 1 / 2 },
        { dayPhase: 'Night', uploadShare: 1 / 2 }
      ]);
      expect(await runCard('Weather of uploads, last 12 weeks')).toEqual([
        { weather: 'Clear', uploadShare: 1 / 2 },
        { weather: 'Cloudy', uploadShare: 1 / 2 }
      ]);
      expect(await runCard('City theme of uploads, last 12 weeks')).toEqual([
        { theme: 'European', uploadShare: 1 / 2 },
        { theme: 'Other', uploadShare: 1 / 2 }
      ]);
      expect(await runCard('Season of uploads, last 12 weeks')).toEqual([
        { season: 'Summer', uploadShare: 1 }
      ]);
      expect(await runCard('Time of day set in photo mode')).toEqual([{ uploadShare: 1 / 2 }]);
    });

    test(`share the uploaders whose latest capture had an override, DLSS or upscaler`, async () => {
      const [first, second, third] = await seedCreators(3);

      // An earlier capture, then the latest.
      await seedUpload(first, {
        createdAt: weeksAgo(2, 1),
        renderConditions: { ...conditions, 'capture.isDlssForcedOff': false }
      });
      await seedUpload(first, {
        renderConditions: { ...conditions, 'capture.isUpscalerForcedOff': true }
      });
      await seedUpload(second, {
        renderConditions: {
          ...conditions,
          'capture.isDlssForcedOff': true,
          'capture.isDynamicResolutionForcedOff': true
        }
      });
      await seedUpload(third, {
        createdAt: weeksAgo(2, 1),
        renderConditions: { ...conditions, 'capture.isDlssForcedOff': true }
      });
      await seedUpload(third, {
        renderConditions: { ...conditions, 'capture.isUpscalerForcedOff': false }
      });

      expect(await runCard('Upscaler forced off')).toEqual([{ uploaderShare: 2 / 3 }]);
      expect(await runCard('Dynamic resolution forced off')).toEqual([{ uploaderShare: 1 / 3 }]);
    });
  });

  function seedCreators(count: number): Promise<Creator[]> {
    return Array.fromAsync({ length: count }, () => createCreator(prisma));
  }

  /**
   * Creates a screenshot uploaded by default last week.
   */
  async function seedUpload(
    creator: Creator | undefined,
    overrides: Partial<Prisma.ScreenshotUncheckedCreateInput>
  ): Promise<void> {
    await createScreenshot(prisma, nn(creator), { createdAt: weeksAgo(1, 1), ...overrides });
  }

  function runCard(name: string): Promise<Document[]> {
    return runDashboardCard(mongo, featureUsageDashboard, name);
  }
});
