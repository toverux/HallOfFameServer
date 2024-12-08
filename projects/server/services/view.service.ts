import { Inject, Injectable } from '@nestjs/common';
import { Creator, Screenshot, View } from '@prisma/client';
import * as dateFns from 'date-fns';
import { LRUCache } from 'lru-cache';
import { JsonObject } from '../common';
import { PrismaService } from './prisma.service';

@Injectable()
export class ViewService {
    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    /**
     * Cache of Creator ID (database one, not the UUID v4) to viewed screenshot
     * IDs to avoid repeatedly querying the database for the same data when the
     * user is browsing screenshots.
     */
    private readonly viewsCache = new LRUCache<
        Creator['id'],
        { maxAge?: number; screenshotIds: Screenshot['id'][] }
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
     * @param maxAgeInDays Max age of the views to consider, in days, so we can
     *                     repropose screenshots the user hasn't seen in a
     *                     while. A max age of `0` or `undefined` means no limit
     *                     (i.e. all past known views count).
     */
    public async getViewedScreenshotIds(
        creatorId: Creator['id'],
        maxAgeInDays: number | undefined
    ): Promise<Screenshot['id'][]> {
        if (this.viewsCache.has(creatorId)) {
            // biome-ignore lint/style/noNonNullAssertion: cannot be null
            const cache = this.viewsCache.get(creatorId)!;

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
                    maxAgeInDays
                        ? {
                              viewedAt: {
                                  gte: dateFns.subDays(new Date(), maxAgeInDays)
                              }
                          }
                        : {}
                ]
            }
        });

        const screenshotIds = screenshots.map(view => view.screenshotId);

        if (screenshotIds.length > 0) {
            this.viewsCache.set(creatorId, {
                maxAge: maxAgeInDays ?? 0,
                screenshotIds
            });
        }

        return screenshotIds;
    }

    /**
     * Marks a screenshot as viewed:
     * - Increments the view count ({@link Screenshot.views}).
     * - Creates a new {@link View} record.
     */
    public async markViewed(
        screenshotId: Screenshot['id'],
        creatorId: Creator['id']
    ): Promise<View> {
        // Update the Screenshot view count and create a new View record.
        // No transaction with the View record creation, this is not critical
        // data & we can reconstruct it.
        await this.prisma.screenshot.update({
            select: { id: true },
            where: { id: screenshotId },
            data: { viewsCount: { increment: 1 } }
        });

        // Add the view to the cache once we recorded it in the database.
        const cache = this.viewsCache.get(creatorId) ?? {
            screenshotIds: []
        };

        cache.screenshotIds.push(screenshotId);

        this.viewsCache.set(creatorId, cache);

        // Create the View record.
        return this.prisma.view.create({
            data: { screenshotId, creatorId }
        });
    }

    /**
     * Serializes a {@link View} to a JSON object for API responses.
     */
    public serialize(view: View): JsonObject {
        return {
            id: view.id,
            creatorId: view.creatorId,
            screenshotId: view.screenshotId,
            viewedAt: view.viewedAt.toISOString()
        };
    }
}
