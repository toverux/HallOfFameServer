import { Inject, Injectable } from '@nestjs/common';
import * as dateFns from 'date-fns';
import { LRUCache } from 'lru-cache';
import type { Creator, Screenshot, View } from '#prisma-lib/client';
import { hours } from '../../shared/utils/duration';
import { type JsonObject, optionallySerialized } from '../../shared/utils/json';
import { CreatorService } from './creator.service';
import { PrismaService } from './prisma.service';
import { ScreenshotStatsService } from './screenshot-stats.service';

@Injectable()
export class ViewService {
  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(CreatorService)
  private readonly creatorService!: CreatorService;

  @Inject(ScreenshotStatsService)
  private readonly screenshotStatsService!: ScreenshotStatsService;

  /**
   * Cache of Creator ID (database one, not the UUID v4) to viewed screenshot IDs to avoid
   * repeatedly querying the database for the same data when the user is browsing screenshots.
   * An entry is cached as its load starts, and `loaded` settles once the load filled its set.
   */
  private readonly viewsCache = new LRUCache<
    Creator['id'],
    { maxAge: number; screenshotIds: Set<Screenshot['id']>; loaded: Promise<void> }
  >({
    // Allow a max of 100 creator entries in the cache.
    max: 100,
    // Cache entries for 2 hours (more if key recency is updated).
    ttl: hours(2)
  });

  /**
   * Returns the IDs of the screenshots viewed by the given Creator.
   *
   * @param creatorId Creator ID to filter by.
   * @param maxAgeInDays Max age of the views to consider, in days, so we can repropose
   *   screenshots the user hasn't seen in a while. A max-age of `0` or
   *   `undefined` means no limit (i.e., all past known views count).
   */
  public async getViewedScreenshotIds(
    creatorId: Creator['id'],
    maxAgeInDays = 0
  ): Promise<Set<Screenshot['id']>> {
    // An entry loaded with another max age holds another set of views, reload it.
    const cache = this.viewsCache.get(creatorId);

    if (cache?.maxAge == maxAgeInDays) {
      await cache.loaded;

      return cache.screenshotIds;
    }

    // Cached before it loads, so concurrent lookups share the load and markViewed() adds a view
    // created meanwhile, which the load may have missed. Cached even when empty for the same.
    const screenshotIds = new Set<Screenshot['id']>();
    const loaded = this.loadViewedScreenshotIds(creatorId, maxAgeInDays, screenshotIds);

    this.viewsCache.set(creatorId, { maxAge: maxAgeInDays, screenshotIds, loaded });

    try {
      await loaded;
    } catch (error) {
      // Drop the failed load for the next lookup to retry, unless another replaced it already.
      if (this.viewsCache.peek(creatorId)?.loaded == loaded) {
        this.viewsCache.delete(creatorId);
      }

      throw error;
    }

    return screenshotIds;
  }

  /**
   * Marks a screenshot as viewed, creates a new {@link View} record.
   * The view count properties will be updated with the background job.
   */
  public async markViewed(screenshotId: Screenshot['id'], creatorId: Creator['id']): Promise<View> {
    // Create the View record.
    const view = await this.prisma.view.create({
      data: { screenshotId, creatorId }
    });

    // Add the view to the Creator's cached views, even while they load: once the View exists, a
    // lookup that starts loads it anyway, but one already running may have missed it.
    // Never start an entry here: it would hold only this view, hiding the older ones from the
    // database until it expires.
    this.viewsCache.get(creatorId)?.screenshotIds.add(screenshotId);

    // Update the Screenshot view count.
    // No transaction with the View record creation, this is not critical data, and a background job
    // will ensure that the view count is kept in sync anyway. It will also update the favoriting
    // percentage and unique view count, which are not handled here.
    await this.prisma.screenshot.update({
      select: { id: true },
      where: { id: screenshotId },
      data: { viewsCount: { increment: 1 } }
    });

    // Update stats.
    this.screenshotStatsService.requestStatsUpdate(screenshotId);

    return view;
  }

  /**
   * Serializes a {@link View} to a JSON object for API responses.
   */
  public serialize(view: View & { creator?: Creator }): JsonObject {
    return {
      id: view.id,
      creatorId: view.creatorId,
      creator: optionallySerialized(view.creator && this.creatorService.serialize(view.creator)),
      screenshotId: view.screenshotId,
      viewedAt: view.viewedAt.toISOString()
    };
  }

  /**
   * Adds the IDs of the screenshots viewed by the given Creator to `screenshotIds`.
   *
   * @see getViewedScreenshotIds
   */
  private async loadViewedScreenshotIds(
    creatorId: Creator['id'],
    maxAgeInDays: number,
    screenshotIds: Set<Screenshot['id']>
  ): Promise<void> {
    const views = await this.prisma.view.findMany({
      select: { screenshotId: true },
      where: {
        AND: [
          { creatorId },
          maxAgeInDays ? { viewedAt: { gte: dateFns.subDays(new Date(), maxAgeInDays) } } : {}
        ]
      }
    });

    for (const view of views) {
      screenshotIds.add(view.screenshotId);
    }
  }
}
