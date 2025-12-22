import assert from 'node:assert/strict';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as sentry from '@sentry/bun';
import * as dateFns from 'date-fns';
import { filter, from, lastValueFrom, mergeMap, retry, toArray } from 'rxjs';
import { z } from 'zod';
import type { Mod, Prisma } from '#prisma-lib/client';
import { nn } from '../../shared/utils';
import type { JsonObject, JsonValue, ParadoxModId } from '../common';
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

    const missingModDetails = await lastValueFrom(
      from(missingModIds).pipe(
        mergeMap(id => this.fetchModDetailsFromParadoxMods(id), ModService.paradoxApiConcurrency),
        filter(details => details != null),
        retry(ModService.paradoxApiRetries),
        toArray()
      )
    );

    if (missingModDetails.length == 0) {
      return foundMods.sort((a, b) => b.subscribersCount - a.subscribersCount);
    }

    await this.prisma.mod.createMany({
      data: missingModDetails.map<Prisma.ModCreateInput>(modDetails => ({
        paradoxModId: modDetails.modId,
        name: modDetails.displayName,
        authorName: modDetails.author,
        shortDescription: modDetails.shortDescription,
        thumbnailUrl: modDetails.displayImagePath,
        tags: modDetails.tags,
        subscribersCount: modDetails.subscriptions,
        knownLastUpdatedAt: modDetails.latestUpdate
      }))
    });

    // We have to fetch new mods via a separate query because createMany doesn't return records.
    // createManyAndReturn() does but it's not available for MongoDB.
    const newMods = await this.prisma.mod.findMany({
      where: { paradoxModId: { in: Array.from(missingModIds) } }
    });

    return foundMods.concat(newMods).sort((a, b) => b.subscribersCount - a.subscribersCount);
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
  @Cron('0 * * * *')
  public async syncModDetailsCron(): Promise<void> {
    try {
      // Find the 50 mods that have the most ancient sync date and that have been updated more than
      // a day ago.
      const modsToCheck = await this.prisma.mod.findMany({
        where: { knownLastUpdatedAt: { lte: dateFns.subDays(new Date(), 1) } },
        orderBy: { knownLastUpdatedAt: 'asc' },
        take: 50,
        select: { paradoxModId: true, knownLastUpdatedAt: true }
      });

      if (!modsToCheck.length) {
        return this.logger.verbose(`No mods to check for updates.`);
      }

      this.logger.log(`Checking mod details freshness for ${modsToCheck.length} mods...`);

      // Make a query for each mod.
      const modDetails = await lastValueFrom(
        from(modsToCheck.map(mod => mod.paradoxModId)).pipe(
          mergeMap(id => this.fetchModDetailsFromParadoxMods(id), ModService.paradoxApiConcurrency),
          filter(details => details != null),
          retry(ModService.paradoxApiRetries),
          toArray()
        )
      );

      // Keep mods that have been updated since the last sync.
      const updatedModDetails = modDetails
        .map(details => ({
          details,
          mod: nn(modsToCheck.find(mod => mod.paradoxModId == details.modId))
        }))
        .filter(({ details, mod }) => details.latestUpdate > mod.knownLastUpdatedAt);

      if (!updatedModDetails.length) {
        return this.logger.verbose(`No mods need to be updated.`);
      }

      // Save the updated mods details.
      await this.prisma.mod.updateMany({
        data: updatedModDetails.map<Prisma.ModUpdateInput>(({ details }) => ({
          name: details.displayName,
          authorName: details.author,
          shortDescription: details.shortDescription,
          thumbnailUrl: details.displayImagePath,
          tags: details.tags,
          subscribersCount: details.subscriptions,
          knownLastUpdatedAt: details.latestUpdate,
          lastSyncedAt: new Date()
        }))
      });

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
   * Returns undefined if the mod cannot be retrieved due to various reasons, such as a failed
   * HTTP request or invalid JSON response, although the error will be logged and sent to Sentry.
   */
  private async fetchModDetailsFromParadoxMods(
    modId: number
  ): Promise<z.infer<typeof ModService.paradoxModDetailsSchema> | undefined> {
    try {
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
        responseData = JSON.parse(responseText) as JsonValue;
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

      // Error: Mod was retired, ignore it ("The mod with the specified modId could not be found").
      if (
        'errorMessage' in responseData &&
        typeof responseData.errorMessage == 'string' &&
        responseData.errorMessage.includes('found')
      ) {
        this.logger.warn(`Mod with ID ${modId} was retired or not found, ignoring.`);
        return undefined;
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
      return ModService.paradoxModDetailsSchema.parse(responseData.modDetail);
    } catch (error) {
      this.logger.error(`Failed to fetch mod details for ${modId}.`, error);

      sentry.captureException(error);

      return undefined;
    }
  }
}
