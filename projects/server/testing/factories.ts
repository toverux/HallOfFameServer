/**
 * Factories inserting records with deterministic, production-like defaults.
 * Tests override only the fields they care about, and pass related records in.
 */

import type { Ban, Creator, Prisma } from '#prisma-lib/client';
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
