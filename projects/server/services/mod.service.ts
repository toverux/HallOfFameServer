import assert from 'node:assert/strict';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as sentry from '@sentry/bun';
import * as dateFns from 'date-fns';
import {
  catchError,
  defer,
  EMPTY,
  from,
  lastValueFrom,
  mergeMap,
  type Observable,
  retry,
  throwError,
  timer,
  toArray
} from 'rxjs';
import { z } from 'zod';
import type { Mod } from '#prisma-lib/client';
import type { ParadoxModId } from '../../shared/utils/branded-types';
import type { JsonObject, JsonValue } from '../../shared/utils/json';
import { PrismaService } from './prisma.service';

/**
 * A mod's state as API clients see it, mapped from the many Paradox Mods use.
 */
type ModState = 'published' | 'removed' | 'blocked' | 'unknown';

/**
 * The fields of a {@link Mod} a successful sync writes.
 */
type SyncedModFields = Pick<
  Mod,
  | 'name'
  | 'authorName'
  | 'shortDescription'
  | 'thumbnailUrl'
  | 'previewUrls'
  | 'tags'
  | 'subscribersCount'
  | 'knownLastUpdatedAt'
  | 'state'
  | 'requiredGameVersion'
  | 'sizeBytes'
  | 'knownLastReleasedAt'
>;

/**
 * The outcome of a mod's lookup on Paradox Mods: the fields to sync, or its retirement.
 */
type ModFetchResult =
  | { kind: 'mod'; modId: ParadoxModId; fields: SyncedModFields }
  | { kind: 'retired'; modId: ParadoxModId; reason: string };

@Injectable()
export class ModService {
  /**
   * Mods synced per batch, by the hourly cron and by {@link resyncAll}.
   */
  private static readonly syncBatchSize = 50;

  /**
   * Days between two syncs of an unpublished mod, see {@link syncModDetailsCron}.
   */
  private static readonly unpublishedModSyncIntervalDays = 30;

  /**
   * Retries of a Paradox API request that failed fast, see {@link retryDelay}.
   */
  private static readonly paradoxApiRetries = 3;

  /**
   * Milliseconds before the first retry, doubling for each next one.
   */
  private static readonly paradoxApiRetryDelay = 250;

  private static readonly paradoxApiConcurrency = 5;

  /**
   * Milliseconds per attempt,
   * so a stalled Paradox API cannot hold a lookup, or the shutdown waiting for a background one.
   */
  private static readonly paradoxApiTimeout = 10_000;

  /**
   * Paradox Mods' error messages for a mod removed or banned, the only errors retiring a mod.
   * Paradox also answers other errors for mods it serves fine again later,
   * ex. "Game could not be found.", so these are matched exactly.
   */
  private static readonly retirementMessages: ReadonlySet<string> = new Set([
    'The mod with the specified modId could not be found',
    'This mod version is banned'
  ]);

  /**
   * Paradox Mods' known states, by the {@link ModState} each maps to.
   */
  private static readonly modStates: ReadonlyMap<string, ModState> = new Map([
    ['published', 'published'],
    ['removedByUser', 'removed'],
    ['autoBlocked', 'blocked'],
    ['disabledByManager', 'blocked']
  ]);

  private static readonly paradoxModDetailsSchema = z.looseObject({
    author: z.string(),
    // Paradox Mods don't trim displayName and shortDescription, they can contain spaces or \r\n's.
    // We also replace inner \r\n's with \n's.
    displayName: z
      .string()
      .trim()
      .transform(val => val.replaceAll('\r\n', '\n')),
    shortDescription: z
      .string()
      .trim()
      .transform(val => val.replaceAll('\r\n', '\n')),
    displayImagePath: z.string(),
    tags: z.array(z.string()),
    subscriptions: z.int(),
    latestUpdate: z.string().pipe(z.coerce.date()),
    state: z.string()
  });

  /**
   * Fields of a mod's details serving only as hints,
   * each validated on its own by {@link parseHint},
   * so a malformed one is left out rather than failing the whole mod.
   * Keys are the fields' paths in the details.
   */
  private static readonly paradoxModHintSchemas = {
    'requiredVersion': z.string().trim().min(1),
    // Each preview also has a `thumbnail`, too small for the mod's UI.
    'screenshots': z
      .array(z.looseObject({ image: z.string() }))
      .transform(screenshots => screenshots.map(screenshot => screenshot.image)),
    // Sent as a numeric string, and may exceed int32.
    'metadata.size_in_memory': z.string().regex(/^\d+$/u).transform(BigInt),
    'creationDate': z.iso.datetime().transform(value => new Date(value)),
    'changelog': z.array(z.looseObject({ released: z.unknown() })),
    // Sent without a zone, as UTC: read so, it matches `latestUpdate` to the second.
    'changelog[].released': z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u)
      .transform(value => new Date(`${value.replace(' ', 'T')}Z`))
      .pipe(z.date())
  };

  private readonly logger = new Logger(ModService.name);

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  /**
   * Retrieves a single Mod record by its Paradox Mod ID.
   * The function returns undefined if the mod cannot be retrieved due to various conditions, see
   * {@link getMods} for more details on the workings of this function.
   *
   * Calling this function and discarding the result makes sense too for database cache
   * pre-hydration scenarios.
   */
  public async getMod(modId: ParadoxModId): Promise<Mod | undefined> {
    const mods = await this.getMods(new Set([modId]));

    return mods[0];
  }

  /**
   * Retrieves (and creates, if necessary) Mod records from the specified Paradox Mod IDs.
   * The process can be error-prone (ex. failed fetches to Paradox's API, removed mods...), and this
   * function is designed to be best-effort (ex. isn't supposed to throw, expectable errors are only
   * logged), so not all mods from the input IDs may be returned.
   * The output array lists published mods first, then sorts by descending subscribers count.
   *
   * Calling this function and discarding the result makes sense too for database cache
   * pre-hydration scenarios.
   */
  public async getMods(modIds: ReadonlySet<ParadoxModId>): Promise<Mod[]> {
    const foundMods = await this.prisma.mod.findMany({
      where: { paradoxModId: { in: Array.from(modIds) } }
    });

    if (foundMods.length == modIds.size) {
      return ModService.availablePublishedFirst(foundMods);
    }

    const missingModIds = modIds.difference(new Set(foundMods.map(mod => mod.paradoxModId)));

    const missingModResults = await this.fetchModsDetails(
      missingModIds,
      modId => `Failed to fetch mod details for new mod ${modId}.`
    );

    if (missingModResults.length == 0) {
      return ModService.availablePublishedFirst(foundMods);
    }

    await this.prisma.mod.createMany({
      // oxlint-disable-next-line oxc/no-map-spread - few records, each spread once
      data: missingModResults.map(result =>
        result.kind == 'mod'
          ? { paradoxModId: result.modId, isRetired: false, ...result.fields }
          : {
              isRetired: true,
              retiredReason: result.reason,
              paradoxModId: result.modId,
              name: 'Unknown',
              authorName: 'Unknown',
              shortDescription: 'Unknown',
              thumbnailUrl: 'Unknown',
              previewUrls: [],
              tags: [],
              subscribersCount: 0,
              knownLastUpdatedAt: new Date(0)
            }
      )
    });

    // We have to fetch new mods via a separate query because createMany doesn't return records.
    // createManyAndReturn() does but it's not available for MongoDB.
    const newMods = await this.prisma.mod.findMany({
      where: { paradoxModId: { in: Array.from(missingModIds) } }
    });

    return ModService.availablePublishedFirst(foundMods.concat(newMods));
  }

  /**
   * Serializes a {@link Mod} to a JSON object for API responses.
   * The formatted fields are for the mod's UI, which cannot format them itself.
   */
  public serialize(mod: Mod, locale: dateFns.Locale): JsonObject {
    return {
      id: mod.id,
      paradoxModId: mod.paradoxModId,
      name: mod.name,
      authorName: mod.authorName,
      shortDescription: mod.shortDescription,
      thumbnailUrl: mod.thumbnailUrl,
      previewUrls: mod.previewUrls,
      tags: mod.tags,
      subscribersCount: mod.subscribersCount,
      knownLastUpdatedAt: mod.knownLastUpdatedAt.toISOString(),
      state: ModService.modState(mod),
      requiredGameVersion: mod.requiredGameVersion,
      sizeBytes: mod.sizeBytes == null ? null : Number(mod.sizeBytes),
      sizeFormatted:
        mod.sizeBytes == null ? null : ModService.formatSize(Number(mod.sizeBytes), locale),
      knownLastReleasedAt: mod.knownLastReleasedAt?.toISOString() ?? null,
      knownLastReleasedAtFormattedDistance:
        mod.knownLastReleasedAt == null
          ? null
          : dateFns.formatDistanceToNowStrict(mod.knownLastReleasedAt, { locale, addSuffix: true }),
      // Labelled as Skyve's, a condition of re-serving it.
      skyve: mod.skyve
        ? {
            stability: mod.skyve.stability,
            note: mod.skyve.note,
            reviewedAt: mod.skyve.reviewedAt?.toISOString() ?? null,
            reviewedAtFormattedDistance:
              mod.skyve.reviewedAt == null
                ? null
                : dateFns.formatDistanceToNowStrict(mod.skyve.reviewedAt, {
                    locale,
                    addSuffix: true
                  }),
            reviewedGameVersion: mod.skyve.reviewedGameVersion
          }
        : null
    };
  }

  /**
   * Runs every hour to refresh from Paradox's API the mods synced the longest ago.
   * A mod is rewritten whether or not its author updated it, as its subscribers count moves anyway.
   * We sync only (at most) 50 mods at a time to be nice on Paradox's servers,
   * so the whole collection takes (number of mods / 50) hours to go around.
   * Mod details do not need to be updated very often, this is not critical info.
   * An unpublished mod is synced monthly at most,
   * so its rare comeback does not cost the budget of live mods.
   *
   * Impl. note: If we start storing too many mods in the future, and this becomes too slow to
   * update, this can be changed to fetch ex. (number of mods / 48) mods per hour, so approximately
   * everything is treated in 48 hours, and/or we can shorten the cron interval.
   */
  @Cron('0 * * * *')
  public async syncModDetailsCron(): Promise<void> {
    try {
      const now = new Date();

      const staleMods = await this.prisma.mod.findMany({
        where: {
          isRetired: false,
          lastSyncedAt: { lte: dateFns.subDays(now, 1) },
          OR: [
            // A mod not synced since states are stored lacks the field, which `null` won't match.
            { state: { isSet: false } },
            { state: null },
            { state: 'published' },
            {
              lastSyncedAt: {
                lte: dateFns.subDays(now, ModService.unpublishedModSyncIntervalDays)
              }
            }
          ]
        },
        orderBy: { lastSyncedAt: 'asc' },
        take: ModService.syncBatchSize,
        select: { paradoxModId: true }
      });

      if (!staleMods.length) {
        return this.logger.verbose(`No mods to sync.`);
      }

      this.logger.log(`Syncing mod details for ${staleMods.length} mods...`);

      const modResults = await this.syncMods(
        staleMods.map(mod => mod.paradoxModId as ParadoxModId),
        modId => `Failed to update mod details for known mod ${modId}.`
      );

      this.logger.log(
        `Saved synced mod details for ${modResults.length} of ${staleMods.length} mods.`
      );
    } catch (error) {
      this.logger.error(`Failed CRON update of mod details.`, error);

      sentry.captureException(error);
    }
  }

  /**
   * Refreshes every mod from Paradox's API, as the hourly cron would, but all in one go.
   * Also takes the mods retired on an error other than a {@link retirementMessages},
   * which a transient error may have retired, and un-retires those Paradox serves.
   */
  public async resyncAll(): Promise<{
    refreshed: number;
    unretired: number;
    retired: number;
    failed: number;
  }> {
    const mods = await this.prisma.mod.findMany({
      where: {
        OR: [
          { isRetired: false },
          { retiredReason: { notIn: Array.from(ModService.retirementMessages) } }
        ]
      },
      select: { paradoxModId: true, isRetired: true }
    });

    const retiredModIds = new Set(
      mods.filter(mod => mod.isRetired).map(mod => mod.paradoxModId as ParadoxModId)
    );

    const counts = { refreshed: 0, unretired: 0, retired: 0, failed: 0 };

    // Batched so each batch's results are saved before the next, should the run be interrupted.
    for (let start = 0; start < mods.length; start += ModService.syncBatchSize) {
      const modIds = mods
        .slice(start, start + ModService.syncBatchSize)
        .map(mod => mod.paradoxModId as ParadoxModId);

      // oxlint-disable-next-line no-await-in-loop - batches run one after the other
      const modResults = await this.syncMods(modIds, modId => `Failed to resync mod ${modId}.`);

      for (const result of modResults) {
        if (result.kind == 'retired') {
          counts.retired++;
        } else if (retiredModIds.has(result.modId)) {
          counts.unretired++;
        } else {
          counts.refreshed++;
        }
      }

      counts.failed += modIds.length - modResults.length;

      this.logger.log(`Resynced ${start + modIds.length} of ${mods.length} mods.`);
    }

    return counts;
  }

  /**
   * Fetches the given known mods from Paradox's API and saves the results,
   * un-retiring a retired mod Paradox serves again.
   * Every mod is stamped as synced, whether its fetch succeeded or not.
   */
  private async syncMods(
    modIds: readonly ParadoxModId[],
    failureMessage: (modId: ParadoxModId) => string
  ): Promise<ModFetchResult[]> {
    const modResults = await this.fetchModsDetails(modIds, failureMessage);

    await this.prisma.$transaction([
      // A mod whose fetch failed is stamped too: it waits for its next turn,
      // where keeping its sync date would hold it at the head of the queue.
      this.prisma.mod.updateMany({
        where: { paradoxModId: { in: Array.from(modIds) } },
        data: { lastSyncedAt: new Date() }
      }),
      ...modResults.map(result =>
        this.prisma.mod.update({
          where: { paradoxModId: result.modId },
          data:
            result.kind == 'mod'
              ? { isRetired: false, retiredReason: null, ...result.fields }
              : { isRetired: true, retiredReason: result.reason }
        })
      )
    ]);

    return modResults;
  }

  /**
   * Fetches the details of each mod from Paradox's API, see {@link fetchModDetailsFromParadoxMods}.
   * A mod whose details cannot be fetched is left out, the failure logged with `failureMessage`.
   */
  private fetchModsDetails(
    modIds: Iterable<ParadoxModId>,
    failureMessage: (modId: ParadoxModId) => string
  ): Promise<ModFetchResult[]> {
    return lastValueFrom(
      from(modIds).pipe(
        mergeMap(
          modId =>
            // Deferred so each retry fetches again, where a promise would replay its outcome.
            defer(() => this.fetchModDetailsFromParadoxMods(modId)).pipe(
              retry({
                count: ModService.paradoxApiRetries,
                delay: (failure, retryCount) => ModService.retryDelay(failure, retryCount)
              }),
              catchError(failure => {
                this.logger.error(failureMessage(modId), failure);
                sentry.captureException(failure);

                return EMPTY;
              })
            ),
          ModService.paradoxApiConcurrency
        ),
        toArray()
      )
    );
  }

  /**
   * Fetches a mod's details from Paradox's API.
   * Returns an enum-like object of kind `retired` when a mod has been removed or banned.
   *
   * @throws {Error} For any unknown error.
   * @throws {assert.AssertionError} For unexpected Paradox API responses shapes.
   * @throws {z.ZodError} If the Paradox API HTTP response seemed correct but the body does
   *   not pass {@link paradoxModDetailsSchema} validation.
   */
  private async fetchModDetailsFromParadoxMods(modId: ParadoxModId): Promise<ModFetchResult> {
    // `&os=` is required, and Windows is the one platform where we're sure to get a result
    // because everything is available to Windows. The "Any" platform only concerns portable
    // assets that can be used everywhere.
    const url = `https://api.paradox-interactive.com/mods?modId=${modId}&os=Windows`;

    this.logger.verbose(`Fetching mod details from Paradox API: ${url}`);

    // The signal also aborts reading the body, which then rejects with the timeout too.
    const response = await fetch(url, {
      signal: AbortSignal.timeout(ModService.paradoxApiTimeout)
    });

    const debugResponseStatusStr = `${response.status} ${response.statusText}`;

    const responseText = await response.text();

    let responseData: JsonValue = null;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      // Assert below will take care.
    }

    this.logger.debug(
      `Fetched mod details from Paradox API (${debugResponseStatusStr}).`,
      responseData
    );

    // First, check that we have a JSON object in response, no matter the status.
    assert.ok(
      responseData && typeof responseData == 'object',
      `Invalid Paradox API response (${debugResponseStatusStr}): ${responseText}`
    );

    // Handle Paradox Mods errors for mods removed or banned.
    // Matched by message because Paradox's API does not provide a useful code, ex. `errorCode` for
    // unavailable mods is always "bad-input".
    // noinspection JSObjectNullOrUndefined false positive
    if (
      'errorMessage' in responseData &&
      typeof responseData.errorMessage == 'string' &&
      ModService.retirementMessages.has(responseData.errorMessage)
    ) {
      this.logger.warn(
        `Mod with ID ${modId} was retired or not found (${responseData.errorMessage}).`
      );

      return { kind: 'retired', modId, reason: responseData.errorMessage };
    }

    // Now assert that we have a 2XX response.
    assert.ok(
      response.ok,
      `Failed to fetch mod details from Paradox API (${debugResponseStatusStr}): ${responseText}`
    );

    // Now assert that we have a seemingly valid response.
    assert.ok(
      'modDetail' in responseData,
      `Missing "modDetail" in response for ${debugResponseStatusStr} response: ${responseText}`
    );

    // Now parse the response, this will also error if there is a validation error.
    const details = ModService.paradoxModDetailsSchema.parse(responseData.modDetail);

    if (!ModService.modStates.has(details.state)) {
      this.logger.warn(`Mod with ID ${modId} has an unknown state "${details.state}".`);

      sentry.captureMessage(`Unknown Paradox Mods state "${details.state}".`, {
        level: 'warning',
        fingerprint: ['paradox-mod-unknown-state', details.state],
        extra: { modId }
      });
    }

    const { metadata } = details;

    return {
      kind: 'mod',
      modId,
      fields: {
        name: details.displayName,
        authorName: details.author,
        shortDescription: details.shortDescription,
        thumbnailUrl: details.displayImagePath,
        previewUrls: this.parseHint(modId, 'screenshots', details.screenshots) ?? [],
        tags: details.tags,
        subscribersCount: details.subscriptions,
        knownLastUpdatedAt: details.latestUpdate,
        state: details.state,
        requiredGameVersion: this.parseHint(modId, 'requiredVersion', details.requiredVersion),
        sizeBytes: this.parseHint(
          modId,
          'metadata.size_in_memory',
          metadata && typeof metadata == 'object' && 'size_in_memory' in metadata
            ? metadata.size_in_memory
            : undefined
        ),
        knownLastReleasedAt: this.parseLastReleasedAt(modId, details)
      }
    };
  }

  /**
   * Reads when a mod's latest version was released: the newest changelog entry,
   * or the creation date for a mod still at its first version, which gets no entry.
   * Null when the dates are malformed, see {@link parseHint}.
   */
  private parseLastReleasedAt(
    modId: ParadoxModId,
    details: Readonly<Record<string, unknown>>
  ): Date | null {
    const changelog = this.parseHint(modId, 'changelog', details.changelog);

    if (!changelog) {
      return null;
    }

    if (!changelog.length) {
      return this.parseHint(modId, 'creationDate', details.creationDate);
    }

    const releaseDates = changelog
      .map(entry => this.parseHint(modId, 'changelog[].released', entry.released))
      .filter(date => date != null);

    return releaseDates.length ? dateFns.max(releaseDates) : null;
  }

  /**
   * Validates a hint field of a mod's details with its {@link paradoxModHintSchemas} schema.
   * A missing or malformed value becomes null, and is reported to Sentry grouped by field,
   * so a change in Paradox's API opens one issue.
   */
  private parseHint<TField extends keyof typeof ModService.paradoxModHintSchemas>(
    modId: ParadoxModId,
    field: TField,
    value: unknown
  ): z.output<(typeof ModService.paradoxModHintSchemas)[TField]> | null {
    const result = ModService.paradoxModHintSchemas[field].safeParse(value);

    if (result.success) {
      return result.data as z.output<(typeof ModService.paradoxModHintSchemas)[TField]>;
    }

    this.logger.warn(
      `Mod with ID ${modId} has a missing or malformed "${field}" (${JSON.stringify(value)}).`
    );

    sentry.captureMessage(`Missing or malformed "${field}" in Paradox Mods details.`, {
      level: 'warning',
      fingerprint: ['paradox-mod-malformed-field', field],
      extra: { modId, value }
    });

    return null;
  }

  /**
   * Delays the next retry of a failed Paradox API request, exponentially.
   * Rethrows the errors a retry would not fix: a timeout, as the API is stalling,
   * and a response failing validation.
   */
  private static retryDelay(error: unknown, retryCount: number): Observable<number> {
    if (
      (error instanceof DOMException && error.name == 'TimeoutError') ||
      error instanceof z.ZodError
    ) {
      return throwError(() => error);
    }

    return timer(ModService.paradoxApiRetryDelay * 2 ** (retryCount - 1));
  }

  /**
   * Drops retired mods, which API results never include, and sorts the rest published first, then
   * by descending subscribers count.
   */
  private static availablePublishedFirst(mods: readonly Mod[]): Mod[] {
    const isPublished = (mod: Mod): number => Number(ModService.modState(mod) == 'published');

    return mods
      .filter(mod => !mod.isRetired)
      .toSorted(
        (a, b) => isPublished(b) - isPublished(a) || b.subscribersCount - a.subscribersCount
      );
  }

  /**
   * Maps a mod's Paradox Mods state to its {@link ModState}.
   * A mod not synced since states are stored counts as published, as retired mods are not served.
   * An unknown state is not reported here: the sync storing it did.
   */
  private static modState(mod: Mod): ModState {
    return mod.state == null ? 'published' : (ModService.modStates.get(mod.state) ?? 'unknown');
  }

  /**
   * Formats a size in the largest decimal unit that keeps it at least 1,
   * rounded to a whole number: "670 kB", or "7 Go" in French.
   * A size rounding to 1000 of a unit moves to the next one, so 999,500 bytes read "1 MB".
   */
  private static formatSize(bytes: number, locale: dateFns.Locale): string {
    const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;

    let exponent = 0;

    // Rounds as displayed, to pick the unit.
    while (exponent < units.length - 1 && Math.round(bytes / 1000 ** exponent) >= 1000) {
      exponent++;
    }

    return new Intl.NumberFormat(locale.code, {
      style: 'unit',
      unit: units[exponent],
      // The short byte unit has no plural in English ("512 byte").
      unitDisplay: exponent == 0 ? 'long' : 'short',
      maximumFractionDigits: 0
    }).format(bytes / 1000 ** exponent);
  }
}
