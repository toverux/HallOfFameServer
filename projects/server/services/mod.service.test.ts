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

      stubParadoxMod(mod, { subscriptions: 2500 });

      await modService.syncModDetailsCron();

      expect(await prisma.mod.findUniqueOrThrow({ where: { id: mod.id } })).toMatchObject({
        subscribersCount: 2500,
        knownLastUpdatedAt: mod.knownLastUpdatedAt,
        lastSyncedAt: now
      });
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
      ...overrides
    }
  });
}
