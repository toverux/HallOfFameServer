import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type { Mod } from '#prisma-lib/client';
import type { JsonValue } from '../../shared/utils/json';
import { createMod } from '../testing/factories';
import { fetchStub } from '../testing/fetch-stub';
import { createServiceTestingModule } from '../testing/testing-module';
import { ModService } from './mod.service';
import { PrismaService } from './prisma.service';

const now = new Date('2026-09-12T10:00:00Z');

const anHourAgo = new Date('2026-09-12T09:00:00Z');

const twoDaysAgo = new Date('2026-09-10T10:00:00Z');

const lastWeek = new Date('2026-09-05T10:00:00Z');

const lastMonth = new Date('2026-08-12T10:00:00Z');

describe('ModService', () => {
  let testingModule: TestingModule;

  let modService: ModService;

  let prisma: PrismaService;

  beforeEach(async () => {
    setSystemTime(now);

    testingModule = await createServiceTestingModule([ModService]);

    modService = testingModule.get(ModService);
    prisma = testingModule.get(PrismaService);
  });

  afterEach(async () => {
    setSystemTime();

    await testingModule.close();
  });

  describe('syncModDetailsCron()', () => {
    test(`refreshes a mod its author has not updated since the last sync`, async () => {
      const mod = await createMod(prisma, { lastSyncedAt: lastWeek });

      stubParadoxMod(mod, {
        subscriptions: 2500,
        state: 'removedByUser',
        requiredVersion: '1.1.12*',
        metadata: { size_in_memory: '7327503033' },
        changelog: [{ released: '2026-01-10 08:30:00' }]
      });

      await modService.syncModDetailsCron();

      expect(await prisma.mod.findUniqueOrThrow({ where: { id: mod.id } })).toMatchObject({
        subscribersCount: 2500,
        knownLastUpdatedAt: mod.knownLastUpdatedAt,
        state: 'removedByUser',
        requiredGameVersion: '1.1.12*',
        sizeBytes: 7_327_503_033n,
        knownLastReleasedAt: new Date('2026-01-10T08:30:00Z'),
        lastSyncedAt: now
      });
    });

    test(`syncs an unpublished mod at most monthly`, async () => {
      const mods = {
        removedLastWeek: await createMod(prisma, {
          state: 'removedByUser',
          lastSyncedAt: lastWeek
        }),
        removedLastMonth: await createMod(prisma, {
          state: 'removedByUser',
          lastSyncedAt: lastMonth
        }),
        unknownLastWeek: await createMod(prisma, { state: 'underReview', lastSyncedAt: lastWeek }),
        publishedLastWeek: await createMod(prisma, { state: 'published', lastSyncedAt: lastWeek }),
        // Never synced since states are stored: the factory leaves the field out.
        absentStateLastWeek: await createMod(prisma, { lastSyncedAt: lastWeek }),
        nullStateLastWeek: await createMod(prisma, { state: null, lastSyncedAt: lastWeek })
      };

      for (const mod of Object.values(mods)) {
        stubParadoxMod(mod);
      }

      await modService.syncModDetailsCron();

      expect(fetchStub.requests.toSorted()).toEqual(
        [
          mods.removedLastMonth,
          mods.publishedLastWeek,
          mods.absentStateLastWeek,
          mods.nullStateLastWeek
        ]
          .map(mod => paradoxModUrl(mod))
          .toSorted()
      );
    });

    test(`takes the 50 mods synced the longest ago, whatever their update date`, async () => {
      const mostRecentlySynced = await createMod(prisma, {
        lastSyncedAt: twoDaysAgo,
        knownLastUpdatedAt: new Date('2025-01-01T10:00:00Z')
      });

      for (let count = 0; count < 50; count++) {
        // oxlint-disable-next-line no-await-in-loop - sequential factory numbering
        stubParadoxMod(await createMod(prisma, { lastSyncedAt: lastWeek }));
      }

      await modService.syncModDetailsCron();

      expect(fetchStub.requests).toHaveLength(50);
      expect(fetchStub.requests).not.toContain(paradoxModUrl(mostRecentlySynced));
    });

    test(`leaves alone a mod synced within the last day`, async () => {
      await createMod(prisma, { lastSyncedAt: anHourAgo });

      await modService.syncModDetailsCron();

      expect(fetchStub.requests).toEqual([]);
    });

    test(`does not take again on the next run a mod whose fetch failed`, async () => {
      const mod = await createMod(prisma, { lastSyncedAt: lastWeek });

      // A response failing validation is not retried.
      fetchStub.respondWithJson(paradoxModUrl(mod), { modDetail: {} });

      const logError = spyOn(Logger.prototype, 'error').mockReturnValue(void 0);

      try {
        await modService.syncModDetailsCron();
        await modService.syncModDetailsCron();
      } finally {
        logError.mockRestore();
      }

      expect(fetchStub.requests).toEqual([paradoxModUrl(mod)]);
    });
  });

  describe('resyncAll()', () => {
    test(`refreshes every mod, and un-retires the ones retired on a transient error`, async () => {
      const live = await createMod(prisma, { lastSyncedAt: anHourAgo });

      const falselyRetired = await createMod(prisma, {
        isRetired: true,
        retiredReason: 'Game could not be found.',
        name: 'Unknown',
        lastSyncedAt: anHourAgo
      });

      const nowRemoved = await createMod(prisma, {
        isRetired: true,
        retiredReason: 'Game could not be found.',
        lastSyncedAt: anHourAgo
      });

      const banned = await createMod(prisma, {
        isRetired: true,
        retiredReason: 'This mod version is banned',
        lastSyncedAt: anHourAgo
      });

      const removed = await createMod(prisma, {
        isRetired: true,
        retiredReason: 'The mod with the specified modId could not be found',
        lastSyncedAt: anHourAgo
      });

      stubParadoxMod(live, { subscriptions: 2500 });
      stubParadoxMod(falselyRetired, { displayName: 'Hall of Fame' });

      fetchStub.respondWithJson(
        paradoxModUrl(nowRemoved),
        { errorCode: 'bad-input', errorMessage: 'This mod version is banned' },
        { status: 400 }
      );

      expect(modService.resyncAll()).resolves.toEqual({
        refreshed: 1,
        unretired: 1,
        retired: 1,
        failed: 0
      });

      expect(fetchStub.requests.toSorted()).toEqual(
        [live, falselyRetired, nowRemoved].map(mod => paradoxModUrl(mod)).toSorted()
      );

      const byId = (mod: Mod): Promise<Mod> =>
        prisma.mod.findUniqueOrThrow({ where: { id: mod.id } });

      expect(await byId(live)).toMatchObject({
        subscribersCount: 2500,
        state: 'published',
        lastSyncedAt: now
      });

      expect(await byId(falselyRetired)).toMatchObject({
        isRetired: false,
        retiredReason: null,
        name: 'Hall of Fame',
        state: 'published',
        lastSyncedAt: now
      });

      expect(await byId(nowRemoved)).toMatchObject({
        isRetired: true,
        retiredReason: 'This mod version is banned',
        lastSyncedAt: now
      });

      expect(await byId(banned)).toEqual(banned);
      expect(await byId(removed)).toEqual(removed);
    });

    test(`leaves a mod whose fetch failed as it was, but stamps it as synced`, async () => {
      const live = await createMod(prisma, { state: 'published', lastSyncedAt: anHourAgo });

      const retired = await createMod(prisma, {
        isRetired: true,
        retiredReason: 'Game could not be found.',
        lastSyncedAt: anHourAgo
      });

      for (const mod of [live, retired]) {
        // A response failing validation is not retried.
        fetchStub.respondWithJson(paradoxModUrl(mod), { modDetail: {} });
      }

      const logError = spyOn(Logger.prototype, 'error').mockReturnValue(void 0);

      try {
        expect(modService.resyncAll()).resolves.toEqual({
          refreshed: 0,
          unretired: 0,
          retired: 0,
          failed: 2
        });
      } finally {
        logError.mockRestore();
      }

      expect(await prisma.mod.findUniqueOrThrow({ where: { id: live.id } })).toEqual({
        ...live,
        lastSyncedAt: now
      });

      expect(await prisma.mod.findUniqueOrThrow({ where: { id: retired.id } })).toEqual({
        ...retired,
        lastSyncedAt: now
      });
    });
  });
});

function paradoxModUrl(mod: Mod): string {
  return `https://api.paradox-interactive.com/mods?modId=${mod.paradoxModId}&os=Windows`;
}

/**
 * Answers the Paradox Mods lookup of `mod` with its own details, unless overridden.
 */
function stubParadoxMod(mod: Mod, overrides: Readonly<Record<string, JsonValue>> = {}): void {
  fetchStub.respondWithJson(paradoxModUrl(mod), {
    modDetail: {
      modId: String(mod.paradoxModId),
      author: mod.authorName,
      displayName: mod.name,
      shortDescription: mod.shortDescription,
      displayImagePath: mod.thumbnailUrl,
      tags: mod.tags,
      subscriptions: mod.subscribersCount,
      latestUpdate: mod.knownLastUpdatedAt.toISOString(),
      state: mod.state ?? 'published',
      requiredVersion: mod.requiredGameVersion ?? '1.6.*',
      metadata: { size_in_memory: String(mod.sizeBytes ?? 996_437) },
      changelog: [],
      creationDate: (mod.knownLastReleasedAt ?? mod.knownLastUpdatedAt).toISOString(),
      ...overrides
    }
  });
}
