import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as sentry from '@sentry/bun';
import * as Bun from 'bun';
import { z } from 'zod';
import type { SkyveCompatibility } from '#prisma-lib/client';
import { seconds } from '../../shared/utils/duration';
import { nn } from '../../shared/utils/type-assertion';
import { config } from '../config';
import { PrismaService } from './prisma.service';

/**
 * Syncs Skyve's compatibility verdicts on mods into the cached mods.
 * Skyve is the community mod manager, its maintainer allows us to re-serve the data as Skyve's.
 */
@Injectable()
export class SkyveService {
  private static readonly catalogueUrl = 'https://skyve-mod.com/v2/api/CompatibilityData';

  /**
   * For the whole catalogue, so a stalled Skyve API cannot hold the sync.
   */
  private static readonly timeout = seconds(60);

  /**
   * At most this many invalid entries go to Sentry, with the count of all of them.
   */
  private static readonly reportedInvalidEntries = 5;

  /**
   * Skyve's `PackageStability` values, each at the index of the integer its API sends.
   * `notReviewed` counts as no verdict.
   */
  private static readonly stabilities = [
    'notReviewed',
    'stable',
    'notEnoughInformation',
    'hasIssues',
    'broken',
    'brokenFromPatch',
    'stableNoNewFeatures',
    'stableNoFutureUpdates',
    'hasIssuesNoFutureUpdates',
    'breaksOnPatch',
    'brokenFromNewVersion',
    'numerousReports',
    'obsolete',
    'cautionWhenUsing'
  ] as const;

  /**
   * A string Skyve sends blank or null for no value.
   */
  private static readonly optionalString = z
    .string()
    .trim()
    .transform(value => value || null)
    .nullable();

  private static readonly entrySchema = z.looseObject({
    id: z.int(),
    stability: z
      .int()
      .transform(value => SkyveService.stabilities[value])
      .pipe(z.enum(SkyveService.stabilities)),
    note: SkyveService.optionalString,
    // Sent without a zone, as UTC, with a varying number of fractional digits.
    // Skyve's placeholder for a mod never reviewed is the year 1.
    reviewDate: z.iso
      .datetime({ local: true })
      .transform(value => (value.startsWith('0001-01-01') ? null : new Date(`${value}Z`)))
      .pipe(z.date().nullable()),
    reviewedGameVersion: SkyveService.optionalString
  });

  private readonly logger = new Logger(SkyveService.name);

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  /**
   * Runs {@link syncCompatibilityData} daily, reporting its failure.
   */
  @Cron('12 0 * * *')
  public async syncCompatibilityDataCron(): Promise<void> {
    try {
      await this.syncCompatibilityData();
    } catch (error) {
      this.logger.error(`Failed CRON sync of Skyve compatibility data.`, error);

      sentry.captureException(error);
    }
  }

  /**
   * Replaces the verdicts on cached mods with those of Skyve's catalogue,
   * which comes whole in one response: a mod without a valid entry loses its verdict.
   *
   * @returns The number of mods whose verdict changed.
   *
   * @throws {Error} See {@link fetchVerdicts}, every verdict is then left as it was.
   */
  public async syncCompatibilityData(): Promise<number> {
    return this.syncVerdicts(await this.fetchVerdicts());
  }

  /**
   * Fetches Skyve's catalogue, by Paradox mod ID, see {@link parseEntries}.
   *
   * @throws {Error} For an error status, or a catalogue without any verdict.
   * @throws {z.ZodError} For a body other than an array.
   */
  private async fetchVerdicts(): Promise<Map<number, SkyveCompatibility>> {
    // The signal also aborts reading the body, which then rejects with the timeout too.
    const response = await fetch(SkyveService.catalogueUrl, {
      headers: { API_KEY: config.skyve.apiKey },
      signal: AbortSignal.timeout(SkyveService.timeout)
    });

    const responseText = await response.text();

    if (!response.ok) {
      const status = `${response.status} ${response.statusText}`;

      throw new Error(`Failed to fetch Skyve's catalogue (${status}): ${responseText}`);
    }

    const entries = z.array(z.unknown()).parse(JSON.parse(responseText));

    const verdicts = this.parseEntries(entries);

    // Rather a stale verdict than none, should Skyve serve an empty or a reshaped catalogue.
    if (!verdicts.size) {
      throw new Error(`Skyve's catalogue has no verdict (${entries.length} entries).`);
    }

    return verdicts;
  }

  /**
   * Sets each verdict on its mod, if cached, and unsets it on every other mod.
   * Only changed verdicts are written, so the transaction stays small.
   */
  private async syncVerdicts(verdicts: ReadonlyMap<number, SkyveCompatibility>): Promise<number> {
    const modIds = Array.from(verdicts.keys());

    const mods = await this.prisma.mod.findMany({
      where: { paradoxModId: { in: modIds } },
      select: { paradoxModId: true, skyve: true }
    });

    const changedMods = mods
      .map(mod => ({ ...mod, verdict: nn(verdicts.get(mod.paradoxModId)) }))
      .filter(mod => !Bun.deepEquals(mod.skyve, mod.verdict));

    const [unset] = await this.prisma.$transaction([
      // `isSet` also matches a stored null, which `null` would not match on an absent field.
      this.prisma.mod.updateMany({
        where: { paradoxModId: { notIn: modIds }, skyve: { isSet: true } },
        data: { skyve: { unset: true } }
      }),
      ...changedMods.map(mod =>
        this.prisma.mod.update({
          where: { paradoxModId: mod.paradoxModId },
          data: { skyve: { set: mod.verdict } }
        })
      )
    ]);

    const changes = `${changedMods.length} changed, ${unset.count} removed`;

    this.logger.log(`Synced Skyve verdicts on ${mods.length} mods: ${changes}.`);

    return changedMods.length + unset.count;
  }

  /**
   * Reads the catalogue entries as verdicts by Paradox mod ID, without the mods Skyve has not
   * reviewed.
   * Invalid entries, an unknown stability included, are skipped and reported to Sentry together,
   * so a change in Skyve's API sends one event per sync.
   */
  private parseEntries(entries: readonly unknown[]): Map<number, SkyveCompatibility> {
    const verdicts = new Map<number, SkyveCompatibility>();

    const invalidEntries: Array<{ entry: unknown; issues: readonly z.core.$ZodIssue[] }> = [];

    for (const entry of entries) {
      const result = SkyveService.entrySchema.safeParse(entry);

      if (!result.success) {
        invalidEntries.push({ entry, issues: result.error.issues });
      } else if (result.data.stability != 'notReviewed') {
        const { id, stability, note, reviewDate, reviewedGameVersion } = result.data;

        verdicts.set(id, { stability, note, reviewedAt: reviewDate, reviewedGameVersion });
      }
    }

    if (invalidEntries.length) {
      // Serialized, as Sentry would cut the entries short at its default depth of 3.
      const sample = JSON.stringify(invalidEntries.slice(0, SkyveService.reportedInvalidEntries));

      this.logger.warn(
        `Skipped ${invalidEntries.length} invalid Skyve catalogue entries: ${sample}`
      );

      sentry.captureMessage(`Skipped invalid Skyve catalogue entries.`, {
        level: 'warning',
        fingerprint: ['skyve-invalid-entries'],
        extra: { count: invalidEntries.length, sample }
      });
    }

    return verdicts;
  }
}
