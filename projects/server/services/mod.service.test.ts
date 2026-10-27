import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import * as sentry from '@sentry/bun';
import { z } from 'zod';
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

      expect(
        await prisma.mod.findUniqueOrThrow({
          select: {
            subscribersCount: true,
            knownLastUpdatedAt: true,
            state: true,
            requiredGameVersion: true,
            sizeBytes: true,
            knownLastReleasedAt: true,
            lastSyncedAt: true
          },
          where: { id: mod.id }
        })
      ).toEqual({
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

    test(`reports a stalling Paradox API as a warning naming the mod`, async () => {
      const mod = await createMod(prisma, { lastSyncedAt: lastWeek });

      fetchStub.handle(paradoxModUrl(mod), () =>
        Promise.reject(new DOMException(`The operation timed out.`, 'TimeoutError'))
      );

      const captureException = spyOn(sentry, 'captureException').mockReturnValue('');
      const logError = spyOn(Logger.prototype, 'error').mockReturnValue(void 0);

      try {
        await modService.syncModDetailsCron();

        expect(captureException.mock.calls).toEqual([
          [
            expect.objectContaining({ name: 'TimeoutError' }),
            { level: 'warning', extra: { modId: mod.paradoxModId } }
          ]
        ]);
      } finally {
        captureException.mockRestore();
        logError.mockRestore();
      }
    });

    test(`reports any other failed fetch as an error naming the mod`, async () => {
      const mod = await createMod(prisma, { lastSyncedAt: lastWeek });

      fetchStub.respondWithJson(paradoxModUrl(mod), { modDetail: {} });

      const captureException = spyOn(sentry, 'captureException').mockReturnValue('');
      const logError = spyOn(Logger.prototype, 'error').mockReturnValue(void 0);

      try {
        await modService.syncModDetailsCron();

        expect(captureException.mock.calls).toEqual([
          [expect.any(z.ZodError), { level: 'error', extra: { modId: mod.paradoxModId } }]
        ]);
      } finally {
        captureException.mockRestore();
        logError.mockRestore();
      }
    });
  });

  describe('resyncAll()', () => {
    test(`refreshes every mod, and un-retires the recoverable ones Paradox serves`, async () => {
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

      const nowPublic = await createMod(prisma, {
        isRetired: true,
        retiredReason: 'User does not have access to this mod',
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
      stubParadoxMod(nowPublic);

      fetchStub.respondWithJson(
        paradoxModUrl(nowRemoved),
        { errorCode: 'bad-input', errorMessage: 'This mod version is banned' },
        { status: 400 }
      );

      expect(modService.resyncAll()).resolves.toEqual({
        refreshed: 1,
        unretired: 2,
        retired: 1,
        failed: 0
      });

      expect(fetchStub.requests.toSorted()).toEqual(
        [live, falselyRetired, nowRemoved, nowPublic].map(mod => paradoxModUrl(mod)).toSorted()
      );

      const byId = (mod: Mod): Promise<Mod> =>
        prisma.mod.findUniqueOrThrow({ where: { id: mod.id } });

      const [liveMod, falselyRetiredMod, nowRemovedMod] = [
        await byId(live),
        await byId(falselyRetired),
        await byId(nowRemoved)
      ];

      expect(liveMod).toMatchObject({ subscribersCount: 2500, state: 'published' });

      expect(falselyRetiredMod).toMatchObject({
        isRetired: false,
        retiredReason: null,
        name: 'Hall of Fame',
        state: 'published'
      });

      expect(nowRemovedMod).toMatchObject({
        isRetired: true,
        retiredReason: 'This mod version is banned'
      });

      expect(await byId(nowPublic)).toMatchObject({ isRetired: false, retiredReason: null });

      // Apart, as Bun's toMatchObject passes on any two dates.
      expect([liveMod, falselyRetiredMod, nowRemovedMod].map(mod => mod.lastSyncedAt)).toEqual([
        now,
        now,
        now
      ]);

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
      screenshots: mod.previewUrls.map(image => ({ image })),
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
