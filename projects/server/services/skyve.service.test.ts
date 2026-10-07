import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import * as sentry from '@sentry/bun';
import type { Mod } from '#prisma-lib/client';
import type { JsonObject, JsonValue } from '../../shared/utils/json';
import { nn } from '../../shared/utils/type-assertion';
import { createCreator, createMod, createScreenshot } from '../testing/factories';
import { fetchStub } from '../testing/fetch-stub';
import { expectedModPayload } from '../testing/payloads';
import { createTestApp, type TestApp } from '../testing/test-app';
import { SkyveService } from './skyve.service';

const skyveUrl = 'https://skyve-mod.com/v2/api/CompatibilityData';

/**
 * A verdict stored by an earlier sync.
 */
const storedVerdict = {
  stability: 'broken',
  note: 'Author retired, no more updates.',
  reviewedAt: new Date('2025-11-13T19:48:07.210Z'),
  reviewedGameVersion: '1.3.6f1'
};

describe('SkyveService', () => {
  let testApp: TestApp;

  let skyveService: SkyveService;

  beforeEach(async () => {
    testApp = await createTestApp();

    skyveService = testApp.app.get(SkyveService);
  });

  afterEach(async () => {
    setSystemTime();

    await testApp.app.close();
  });

  describe('syncCompatibilityData()', () => {
    test(`serves a cached mod's verdict in its playset, fetched with the API key`, async () => {
      const mod = await createMod(testApp.prisma);

      fetchStub.respondWithJson(skyveUrl, [
        skyveEntry(mod.paradoxModId, {
          stability: 5,
          note: 'Broken since the 1.3 patch.',
          reviewDate: '2025-11-13T19:48:07.21',
          reviewedGameVersion: '1.3.6f1'
        })
      ]);

      await skyveService.syncCompatibilityData();

      // 13 months on, which reads "1 year ago" rather than "about 1 year ago".
      setSystemTime(new Date('2026-12-12T10:00:00Z'));

      expect(await servePlayset([mod])).toEqual([
        expectedModPayload(mod, {
          skyve: {
            stability: 'brokenFromPatch',
            note: 'Broken since the 1.3 patch.',
            reviewedAt: '2025-11-13T19:48:07.210Z',
            reviewedAtFormattedDistance: '1 year ago',
            reviewedGameVersion: '1.3.6f1'
          }
        })
      ]);

      expect(fetchStub.sentRequests.map(request => request.headers.get('API_KEY'))).toEqual([
        'skyve-inert'
      ]);
    });

    test(`serves no verdict on a mod without an entry, or not reviewed`, async () => {
      const mods = {
        reviewed: await createMod(testApp.prisma),
        withoutEntry: await createMod(testApp.prisma),
        notReviewed: await createMod(testApp.prisma)
      };

      fetchStub.respondWithJson(skyveUrl, [
        skyveEntry(mods.reviewed.paradoxModId),
        skyveEntry(mods.notReviewed.paradoxModId, { stability: 0 }),
        // An uncached mod is left out, not cached.
        skyveEntry(90_001)
      ]);

      await skyveService.syncCompatibilityData();

      expect(await serveStabilities(Object.values(mods))).toEqual({
        [mods.reviewed.paradoxModId]: 'stable',
        [mods.withoutEntry.paradoxModId]: null,
        [mods.notReviewed.paradoxModId]: null
      });

      expect(await testApp.prisma.mod.count()).toBe(3);
    });

    test(`removes the verdict of a mod whose entry left the catalogue`, async () => {
      const mods = {
        reviewed: await createMod(testApp.prisma),
        // Never synced: the factory leaves the field out.
        absent: await createMod(testApp.prisma),
        withVerdict: await createMod(testApp.prisma, { skyve: storedVerdict }),
        withNullVerdict: await createMod(testApp.prisma, { skyve: null })
      };

      fetchStub.respondWithJson(skyveUrl, [skyveEntry(mods.reviewed.paradoxModId)]);

      await skyveService.syncCompatibilityData();

      expect(await serveStabilities(Object.values(mods))).toEqual({
        [mods.reviewed.paradoxModId]: 'stable',
        [mods.absent.paradoxModId]: null,
        [mods.withVerdict.paradoxModId]: null,
        [mods.withNullVerdict.paradoxModId]: null
      });
    });

    test(`skips invalid entries and unknown stabilities, reported once`, async () => {
      const mods = {
        reviewed: await createMod(testApp.prisma),
        invalid: await createMod(testApp.prisma, { skyve: storedVerdict }),
        unknownStability: await createMod(testApp.prisma, { skyve: storedVerdict })
      };

      fetchStub.respondWithJson(skyveUrl, [
        skyveEntry(mods.reviewed.paradoxModId),
        skyveEntry(mods.invalid.paradoxModId, { reviewDate: 'yesterday' }),
        skyveEntry(mods.unknownStability.paradoxModId, { stability: 99 })
      ]);

      const captureMessage = spyOn(sentry, 'captureMessage').mockReturnValue('');

      try {
        await skyveService.syncCompatibilityData();

        // One report per sync, however many entries a reshaped catalogue invalidates.
        expect(captureMessage.mock.calls).toEqual([
          [
            expect.any(String),
            expect.objectContaining({
              level: 'warning',
              fingerprint: ['skyve-invalid-entries'],
              extra: { count: 2, sample: expect.stringContaining('"stability":99') }
            })
          ]
        ]);
      } finally {
        captureMessage.mockRestore();
      }

      expect(await serveStabilities(Object.values(mods))).toEqual({
        [mods.reviewed.paradoxModId]: 'stable',
        [mods.invalid.paradoxModId]: null,
        [mods.unknownStability.paradoxModId]: null
      });
    });

    test(`serves blank notes, versions and review dates as null, and dates as UTC`, async () => {
      const mods = {
        blanks: await createMod(testApp.prisma, { subscribersCount: 3000 }),
        nulls: await createMod(testApp.prisma, { subscribersCount: 2000 }),
        padded: await createMod(testApp.prisma, { subscribersCount: 1000 })
      };

      fetchStub.respondWithJson(skyveUrl, [
        skyveEntry(mods.blanks.paradoxModId, {
          note: ' \r\n',
          // Skyve's placeholder date for a mod never reviewed.
          reviewDate: '0001-01-01T00:00:00',
          reviewedGameVersion: ' '
        }),
        skyveEntry(mods.nulls.paradoxModId, { note: null, reviewedGameVersion: null }),
        skyveEntry(mods.padded.paradoxModId, {
          note: ' Use the beta branch.\r\n',
          reviewDate: '2024-03-26T08:54:39.32',
          reviewedGameVersion: ' 1.6.2f1\r\n'
        })
      ]);

      // A zone-less date read as local time would shift by the process timezone.
      // oxlint-disable node/no-process-env - the timezone is only set through the environment
      const timezone = process.env.TZ;

      process.env.TZ = 'Asia/Tokyo';

      try {
        await skyveService.syncCompatibilityData();
      } finally {
        process.env.TZ = nn(timezone);
      }
      // oxlint-enable node/no-process-env

      expect(await servePlayset(Object.values(mods))).toEqual([
        expectedModPayload(mods.blanks, {
          skyve: {
            stability: 'stable',
            note: null,
            reviewedAt: null,
            reviewedAtFormattedDistance: null,
            reviewedGameVersion: null
          }
        }),
        expectedModPayload(mods.nulls, {
          skyve: {
            stability: 'stable',
            note: null,
            reviewedAt: '2026-08-30T14:00:00.123Z',
            reviewedAtFormattedDistance: expect.any(String),
            reviewedGameVersion: null
          }
        }),
        expectedModPayload(mods.padded, {
          skyve: {
            stability: 'stable',
            note: 'Use the beta branch.',
            reviewedAt: '2024-03-26T08:54:39.320Z',
            reviewedAtFormattedDistance: expect.any(String),
            reviewedGameVersion: '1.6.2f1'
          }
        })
      ]);
    });

    test(`serves a note's line breaks as line feeds`, async () => {
      const mod = await createMod(testApp.prisma);

      fetchStub.respondWithJson(skyveUrl, [
        skyveEntry(mod.paradoxModId, {
          note: 'Known issue:\r\nSome cranes are rotated.\r\n\r\nFixed in 1.4.\rUse the beta.'
        })
      ]);

      await skyveService.syncCompatibilityData();

      expect(await servePlayset([mod])).toMatchObject([
        {
          skyve: { note: 'Known issue:\nSome cranes are rotated.\n\nFixed in 1.4.\nUse the beta.' }
        }
      ]);
    });
  });

  describe('syncCompatibilityDataCron()', () => {
    // Every row has all three columns: Bun reads a callback's extra parameter as `done`.
    const failedFetches: ReadonlyArray<[string, JsonValue, ResponseInit]> = [
      ['an error status', { message: 'Unauthorized' }, { status: 401 }],
      ['a body other than an array', { entries: [] }, {}],
      ['an empty catalogue', [], {}],
      ['a catalogue without a valid entry', [skyveEntry(90_001, { stability: 'stable' })], {}]
    ];

    test.each(failedFetches)(`keeps the stored verdicts and reports %s`, async (_, body, init) => {
      const mod = await createMod(testApp.prisma, { skyve: storedVerdict });

      fetchStub.respondWithJson(skyveUrl, body, init);

      const captureException = spyOn(sentry, 'captureException').mockReturnValue('');
      const captureMessage = spyOn(sentry, 'captureMessage').mockReturnValue('');
      const logError = spyOn(Logger.prototype, 'error').mockReturnValue(void 0);

      try {
        await skyveService.syncCompatibilityDataCron();

        expect(captureException).toHaveBeenCalledTimes(1);
      } finally {
        captureException.mockRestore();
        captureMessage.mockRestore();
        logError.mockRestore();
      }

      expect(await serveStabilities([mod])).toEqual({ [mod.paradoxModId]: 'broken' });
    });
  });

  /**
   * Serves the stability of each mod in `mods` by its Paradox mod ID, or null for no verdict.
   */
  async function serveStabilities(mods: readonly Mod[]): Promise<Record<number, string | null>> {
    const playset = (await servePlayset(mods)) as Array<{
      paradoxModId: number;
      skyve: { stability: string } | null;
    }>;

    return Object.fromEntries(playset.map(mod => [mod.paradoxModId, mod.skyve?.stability ?? null]));
  }

  /**
   * Serves the playset of a screenshot showing `mods`.
   */
  async function servePlayset(mods: readonly Mod[]): Promise<unknown> {
    const screenshot = await createScreenshot(testApp.prisma, await createCreator(testApp.prisma), {
      paradoxModIds: mods.map(mod => mod.paradoxModId)
    });

    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/v1/screenshots/${screenshot.id}/playset`
    });

    expect(response.statusCode).toBe(200);

    return response.json<unknown>();
  }
});

/**
 * A catalogue entry as Skyve's API serves it, for a stable mod unless overridden.
 */
function skyveEntry(paradoxModId: number, overrides: Readonly<JsonObject> = {}): JsonObject {
  return {
    id: paradoxModId,
    name: `Mod ${paradoxModId}`,
    fileName: `Mod${paradoxModId}.dll`,
    authorId: 'toverux',
    note: '',
    reviewDate: '2026-08-30T14:00:00.123',
    reviewedGameVersion: '1.6.2f1',
    stability: 1,
    usage: 1,
    savegameEffect: 1,
    type: 10,
    removalSteps: '',
    thumbnailUrl: `https://modscontent.paradox-interactive.com/${paradoxModId}/cover_1.jpg`,
    activeReports: 0,
    requiredDLCs: [],
    tags: ['Gameplay Balance'],
    links: null,
    statuses: null,
    interactions: null,
    ...overrides
  };
}
