/**
 * Factories inserting records with deterministic, production-like defaults.
 * Tests override only the fields they care about, and pass related records in.
 */

import type { Ban, Creator, Favorite, Mod, Prisma, Screenshot, View } from '#prisma-lib/client';
import { nn } from '../../shared/utils/type-assertion';
import { CreatorService } from '../services/creator.service';
import type { PrismaService } from '../services/prisma.service';

/**
 * Numbers records per model, so unique fields stay unique within a test.
 * Reset before every test, so a test gets the same values whether it runs alone or in the suite.
 */
const sequences = new Map<string, number>();

export function resetFactorySequences(): void {
  sequences.clear();
}

/**
 * Creates a Creator the way a first mod login does, with a Paradox account ID.
 * The name slug derives from the name unless overridden too.
 */
export function createCreator(
  prisma: PrismaService,
  overrides: Partial<Omit<Prisma.CreatorCreateInput, 'creatorName'>> & {
    creatorName?: string | null;
  } = {}
): Promise<Creator> {
  const sequence = nextSequence('creator');

  const { creatorName = `Mayor ${sequence}` } = overrides;

  return prisma.creator.create({
    data: {
      // A UUID v4, as the mod requires, numbered in its last group.
      // oxlint-disable-next-line no-magic-numbers - length of the UUID's last group
      creatorId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      creatorIdProvider: 'paradox',
      creatorName,
      creatorNameSlug: CreatorService.getCreatorNameSlug(creatorName),
      // Shaped like Unity's `SystemInfo.deviceUniqueIdentifier`, a SHA-1 hex digest.
      // oxlint-disable-next-line no-magic-numbers - hexadecimal, SHA-1 hex digest length
      hwids: [sequence.toString(16).padStart(40, '0')],
      // Documentation range (RFC 5737), never routable.
      ips: [`203.0.113.${sequence}`],
      socials: [],
      metadata: {},
      ...overrides
    }
  });
}

/**
 * Creates a Screenshot by the given Creator, as an upload from the game leaves it.
 */
export function createScreenshot(
  prisma: PrismaService,
  creator: Pick<Creator, 'id' | 'hwids' | 'ips'>,
  overrides: Partial<Prisma.ScreenshotUncheckedCreateInput> = {}
): Promise<Screenshot> {
  const sequence = nextSequence('screenshot');

  const blobNameBase = `${creator.id}/screenshot-${sequence}`;

  return prisma.screenshot.create({
    data: {
      creatorId: creator.id,
      hwid: creator.hwids[0] ?? null,
      ip: creator.ips[0] ?? null,
      cityName: `City ${sequence}`,
      cityMilestone: 12,
      cityPopulation: 120_000,
      mapName: 'Lakeland',
      imageUrlThumbnail: `${blobNameBase}-thumbnail.jpg`,
      imageUrlFHD: `${blobNameBase}-fhd.jpg`,
      imageUrl4K: `${blobNameBase}-4k.jpg`,
      shareParadoxModIds: true,
      paradoxModIds: [],
      shareRenderSettings: true,
      renderSettings: {},
      metadata: {},
      ...overrides
    }
  });
}

/**
 * Records that the given Creator liked the given Screenshot, from their latest IP and hardware ID
 * as a like from the game does.
 * The Screenshot's counters are left as they are.
 */
export function createFavorite(
  prisma: PrismaService,
  screenshot: Pick<Screenshot, 'id'>,
  creator: Pick<Creator, 'id' | 'hwids' | 'ips'>,
  overrides: Partial<Prisma.FavoriteUncheckedCreateInput> = {}
): Promise<Favorite> {
  return prisma.favorite.create({
    data: {
      screenshotId: screenshot.id,
      creatorId: creator.id,
      ip: nn(creator.ips[0]),
      hwid: creator.hwids[0] ?? null,
      ...overrides
    }
  });
}

/**
 * Records that the given Creator has seen the given Screenshot.
 */
export function createView(
  prisma: PrismaService,
  screenshot: Pick<Screenshot, 'id'>,
  creator: Pick<Creator, 'id'>,
  overrides: Partial<Prisma.ViewUncheckedCreateInput> = {}
): Promise<View> {
  return prisma.view.create({
    data: { screenshotId: screenshot.id, creatorId: creator.id, ...overrides }
  });
}

/**
 * Creates a Mod as the first lookup on Paradox Mods caches it.
 */
export function createMod(
  prisma: PrismaService,
  overrides: Partial<Prisma.ModCreateInput> = {}
): Promise<Mod> {
  const sequence = nextSequence('mod');

  return prisma.mod.create({
    data: {
      // oxlint-disable-next-line no-magic-numbers - realistic Paradox Mods IDs are 5-digit
      paradoxModId: 80_000 + sequence,
      isRetired: false,
      name: `Mod ${sequence}`,
      authorName: `Modder ${sequence}`,
      shortDescription: 'Adds a few things to the game.',
      thumbnailUrl: `https://mods.paradoxplaza.com/thumbnails/mod-${sequence}.jpg`,
      tags: ['Code Mod'],
      subscribersCount: 1000,
      knownLastUpdatedAt: new Date('2026-01-15T10:00:00Z'),
      ...overrides
    }
  });
}

/**
 * Creates a Ban; its target (IP, hardware ID, and/or creator) comes from the overrides.
 */
export function createBan(
  prisma: PrismaService,
  overrides: Partial<Prisma.BanUncheckedCreateInput>
): Promise<Ban> {
  return prisma.ban.create({
    data: {
      reason: 'uploading inappropriate content',
      ...overrides
    }
  });
}

function nextSequence(model: string): number {
  const sequence = (sequences.get(model) ?? 0) + 1;

  sequences.set(model, sequence);

  return sequence;
}
