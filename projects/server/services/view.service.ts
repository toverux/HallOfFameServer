import { Inject, Injectable } from '@nestjs/common';
import type { Creator, Screenshot, View } from '@prisma/client';
import * as dateFns from 'date-fns';
import { LRUCache } from 'lru-cache';
import { nn } from '../../shared/utils';
import { type JsonObject, optionallySerialized } from '../common';
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
   */
  private readonly viewsCache = new LRUCache<
    Creator['id'],
    { maxAge?: number; screenshotIds: Set<Screenshot['id']> }
  >({
    // Allow a max of 100 creator entries in the cache.
    max: 100,
    // Cache entries for 2 hours (more if key recency is updated).
    ttl: 1000 * 60 * 60 * 2
  });

  /**
   * Returns the IDs of the screenshots viewed by the given Creator.
   *
   * @param creatorId    Creator ID to filter by.
   * @param maxAgeInDays Max age of the views to consider, in days, so we can repropose
   *                     screenshots the user hasn't seen in a while. A max age of `0` or
   *                     `undefined` means no limit (i.e. all past known views count).
   */
  public async getViewedScreenshotIds(
    creatorId: Creator['id'],
    maxAgeInDays: number | undefined
  ): Promise<Set<Screenshot['id']>> {
    if (this.viewsCache.has(creatorId)) {
      const cache = nn(this.viewsCache.get(creatorId));

      if (cache.maxAge && cache.maxAge != maxAgeInDays) {
        // If the max age has changed, we need to clear the cache entry
        // to apply the new limit.
        this.viewsCache.delete(creatorId);
      } else {
        cache.maxAge = maxAgeInDays ?? 0;

        return cache.screenshotIds;
      }
    }

    const screenshots = await this.prisma.view.findMany({
      select: { screenshotId: true },
      where: {
        // biome-ignore lint/style/useNamingConvention: prisma
        AND: [
          { creatorId },
          maxAgeInDays ? { viewedAt: { gte: dateFns.subDays(new Date(), maxAgeInDays) } } : {}
        ]
      }
    });

    const screenshotIds = new Set(screenshots.map(view => view.screenshotId));

    if (screenshotIds.size > 0) {
      this.viewsCache.set(creatorId, {
        maxAge: maxAgeInDays ?? 0,
        screenshotIds
      });
    }

    return screenshotIds;
  }

  /**
   * Marks a screenshot as viewed, creates a new {@link View} record.
   * The view count properties will be updated with the background job.
   */
  public async markViewed(screenshotId: Screenshot['id'], creatorId: Creator['id']): Promise<View> {
    // Add the view to the cache once we recorded it in the database.
    const cache = this.viewsCache.get(creatorId) ?? {
      screenshotIds: new Set()
    };

    cache.screenshotIds.add(screenshotId);

    this.viewsCache.set(creatorId, cache);

    // Create the View record.
    const view = await this.prisma.view.create({
      data: { screenshotId, creatorId }
    });

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
}
