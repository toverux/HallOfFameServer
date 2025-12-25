import assert from 'node:assert/strict';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as sentry from '@sentry/bun';
import * as dateFns from 'date-fns';
import { catchError, EMPTY, from, lastValueFrom, mergeMap, retry, toArray } from 'rxjs';
import { z } from 'zod';
import type { Mod, Prisma } from '#prisma-lib/client';
import type { ParadoxModId } from '../../shared/utils/branded-types';
import type { JsonObject, JsonValue } from '../../shared/utils/json';
import { nn } from '../../shared/utils/type-assertion';
import { PrismaService } from './prisma.service';

@Injectable()
export class ModService {
  private static readonly paradoxApiRetries = 3;

  private static readonly paradoxApiConcurrency = 5;

  private static readonly paradoxModDetailsSchema = z.looseObject({
    modId: z.string().pipe(z.coerce.number()),
    author: z.string(),
    displayName: z.string(),
    shortDescription: z.string().trim(),
    displayImagePath: z.string(),
    tags: z.array(z.string()),
    subscriptions: z.int(),
    latestUpdate: z.string().pipe(z.coerce.date())
  });

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
   * The output array is sorted by descending subscribers count.
   *
   * Calling this function and discarding the result makes sense too for database cache
   * pre-hydration scenarios.
   */
  public async getMods(modIds: ReadonlySet<ParadoxModId>): Promise<Mod[]> {
    const foundMods = await this.prisma.mod.findMany({
      where: { paradoxModId: { in: Array.from(modIds) } }
    });

    if (foundMods.length == modIds.size) {
      return foundMods.sort((a, b) => b.subscribersCount - a.subscribersCount);
    }

    const missingModIds = modIds.difference(new Set(foundMods.map(mod => mod.paradoxModId)));

    const missingModResults = await lastValueFrom(
      from(missingModIds).pipe(
        mergeMap(
          modId =>
            from(this.fetchModDetailsFromParadoxMods(modId)).pipe(
              retry(ModService.paradoxApiRetries),
              catchError(error => {
                this.logger.error(`Failed to fetch mod details for new mod ${modId}.`, error);
                sentry.captureException(error);

                return EMPTY;
              })
            ),
          ModService.paradoxApiConcurrency
        ),
        toArray()
      )
    );

    if (missingModResults.length == 0) {
      return foundMods.sort((a, b) => b.subscribersCount - a.subscribersCount);
    }

    await this.prisma.mod.createMany({
      data: missingModResults.map<Prisma.ModCreateInput>(result =>
        result.kind == 'mod'
          ? {
              paradoxModId: result.details.modId,
              isRetired: false,
              name: result.details.displayName,
              authorName: result.details.author,
              shortDescription: result.details.shortDescription,
              thumbnailUrl: result.details.displayImagePath,
              tags: result.details.tags,
              subscribersCount: result.details.subscriptions,
              knownLastUpdatedAt: result.details.latestUpdate
            }
          : {
              isRetired: true,
              retiredReason: result.reason,
              paradoxModId: result.modId,
              name: 'Unknown',
              authorName: 'Unknown',
              shortDescription: 'Unknown',
              thumbnailUrl: 'Unknown',
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

    return foundMods
      .concat(newMods)
      .filter(mod => !mod.isRetired)
      .sort((a, b) => b.subscribersCount - a.subscribersCount);
  }

  /**
   * Serializes a {@link Mod} to a JSON object for API responses.
   */
  public serialize(mod: Mod): JsonObject {
    return {
      id: mod.id,
      paradoxModId: mod.paradoxModId,
      name: mod.name,
      authorName: mod.authorName,
      shortDescription: mod.shortDescription,
      thumbnailUrl: mod.thumbnailUrl,
      tags: mod.tags,
      subscribersCount: mod.subscribersCount,
      knownLastUpdatedAt: mod.knownLastUpdatedAt.toISOString()
    };
  }

  /**
   * Runs every hour to fetch the latest mod details from Paradox's API and update the database.
   * We update only (at most) 50 mods at a time to be nice on Paradox's servers.
   * Mod details do not need to be updated very often, this is not critical info.
   *
   * Impl. note: If we start storing too many mods in the future, and this becomes too slow to
   * update, this can be changed to fetch ex. (number of mods / 48) mods per hour, so approximately
   * everything is treated in 48 hours, and/or we can shorten the cron interval.
   */
  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: inherently sequential and simple
  @Cron('0 * * * *')
  public async syncModDetailsCron(): Promise<void> {
    try {
      // Find the 50 mods that have the most ancient sync date and that have been updated more than
      // a day ago.
      const modsToCheck = await this.prisma.mod.findMany({
        where: {
          isRetired: false,
          knownLastUpdatedAt: { lte: dateFns.subDays(new Date(), 1) }
        },
        orderBy: { knownLastUpdatedAt: 'asc' },
        take: 50,
        select: { paradoxModId: true, knownLastUpdatedAt: true }
      });

      if (!modsToCheck.length) {
        return this.logger.verbose(`No mods to check for updates.`);
      }

      this.logger.log(`Checking mod details freshness for ${modsToCheck.length} mods...`);

      // Make a query for each mod.
      const modResults = await lastValueFrom(
        from(modsToCheck.map(mod => mod.paradoxModId as ParadoxModId)).pipe(
          mergeMap(
            modId =>
              from(this.fetchModDetailsFromParadoxMods(modId)).pipe(
                retry(ModService.paradoxApiRetries),
                catchError(error => {
                  this.logger.error(`Failed to update mod details for known mod ${modId}.`, error);
                  sentry.captureException(error);

                  return EMPTY;
                })
              ),
            ModService.paradoxApiConcurrency
          ),
          toArray()
        )
      );

      // Keep mods that have been updated since the last sync.
      const updatedModDetails = modResults
        .map(result => ({
          result,
          mod: nn(modsToCheck.find(mod => mod.paradoxModId == result.modId))
        }))
        .filter(
          ({ result, mod }) =>
            result.kind == 'retired' || result.details.latestUpdate > mod.knownLastUpdatedAt
        );

      if (!updatedModDetails.length) {
        return this.logger.verbose(`No mods need to be updated.`);
      }

      // Save the updated mods details.
      await this.prisma.$transaction(
        updatedModDetails.map(({ result }) =>
          this.prisma.mod.update({
            where: { paradoxModId: result.modId },
            data:
              result.kind == 'mod'
                ? {
                    name: result.details.displayName,
                    authorName: result.details.author,
                    shortDescription: result.details.shortDescription,
                    thumbnailUrl: result.details.displayImagePath,
                    tags: result.details.tags,
                    subscribersCount: result.details.subscriptions,
                    knownLastUpdatedAt: result.details.latestUpdate,
                    lastSyncedAt: new Date()
                  }
                : {
                    isRetired: true,
                    retiredReason: result.reason,
                    lastSyncedAt: new Date()
                  }
          })
        )
      );

      this.logger.log(
        `Saved updated mod details for ${updatedModDetails.length} of ${modsToCheck.length} mods.`
      );
    } catch (error) {
      this.logger.error(`Failed CRON update of mod details.`, error);

      sentry.captureException(error);
    }
  }

  /**
   * Fetches a mod's details from Paradox's API.
   * Returns an enum-like object of kind `retired` when a mod has been removed or banned.
   *
   * @throws Error                 for any unknown error.
   * @throws assert.AssertionError for unexpected Paradox API responses shapes.
   * @throws z.ZodError            if the Paradox API HTTP response seemed correct but the body does
   *                               not pass {@link paradoxModDetailsSchema} validation.
   */
  private async fetchModDetailsFromParadoxMods(modId: ParadoxModId): Promise<
    | {
        kind: 'mod';
        modId: ParadoxModId;
        details: z.infer<typeof ModService.paradoxModDetailsSchema>;
      }
    | { kind: 'retired'; modId: ParadoxModId; reason: string }
  > {
    // `&os=` is required, and Windows is the one platform where we're sure to get a result
    // because everything is available to Windows. The "Any" platform only concerns portable
    // assets that can be used everywhere.
    const url = `https://api.paradox-interactive.com/mods?modId=${modId}&os=Windows`;

    this.logger.verbose(`Fetching mod details from Paradox API: ${url}`);

    const response = await fetch(url);

    const debugResponseStatusStr = `${response.status} ${response.statusText}`;

    let responseText: string | null = null;
    let responseData: JsonValue = null;
    try {
      responseText = await response.text();
      responseData = JSON.parse(responseText);
    } catch {
      // Assert below will take care.
    }

    this.logger.debug(
      `Fetched mod details from Paradox API (${debugResponseStatusStr}).`,
      responseData
    );

    // First, check that we have a JSON object in response, no matter the status.
    assert(
      responseData && typeof responseData == 'object',
      `Invalid Paradox API response (${debugResponseStatusStr}): ${responseText}`
    );

    // Handle Paradox Mods error for mods that cannot be found, have been retired, etc.
    // noinspection JSObjectNullOrUndefined false positive
    if (
      'errorMessage' in responseData &&
      typeof responseData.errorMessage == 'string' &&
      // Match by message because Paradox's API does not provide a useful code.
      // Ex. `errorCode` for unavailable mods is always "bad-input".
      // "The mod with the specified modId could not be found"
      // "This mod version is banned"
      // biome-ignore lint/performance/useTopLevelRegex: infrequent call
      responseData.errorMessage.match(/found|banned/i)
    ) {
      this.logger.warn(
        `Mod with ID ${modId} was retired or not found (${responseData.errorMessage}).`
      );

      return { kind: 'retired', modId, reason: responseData.errorMessage };
    }

    // Now assert that we have a 2XX response.
    assert(
      response.ok,
      `Failed to fetch mod details from Paradox API (${debugResponseStatusStr}): ${responseText}`
    );

    // Now assert that we have a seemingly valid response.
    assert(
      'modDetail' in responseData,
      `Missing "modDetail" in response for ${debugResponseStatusStr} response: ${responseText}`
    );

    // Now parse the response, this will also error if there is a validation error.
    // noinspection JSObjectNullOrUndefined false positive
    return {
      kind: 'mod',
      modId,
      details: ModService.paradoxModDetailsSchema.parse(responseData.modDetail)
    };
  }
}
