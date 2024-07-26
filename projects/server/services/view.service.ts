import { Inject, Injectable } from '@nestjs/common';
import { Screenshot, View } from '@prisma/client';
import * as dateFns from 'date-fns';
import { LRUCache } from 'lru-cache';
import type { CreatorID, IPAddress } from '../common';
import { CreatorService } from './creator.service';
import { PrismaService } from './prisma.service';

@Injectable()
export class ViewService {
    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    @Inject(CreatorService)
    private readonly creatorService!: CreatorService;

    /**
     * Cache of IP addresses to viewed screenshot IDs to avoid repeatedly
     * querying the database for the same data when the user is browsing
     * screenshots.
     */
    private readonly viewsCache = new LRUCache<string, View['id'][]>({
        // Allow a max of 100 IP addresses entries in the cache.
        max: 100,
        // Allow a max 10,000 view IDs in the cache.
        maxSize: 10000,
        sizeCalculation: value => value.length,
        // Cache entries for 2 hours (more if key recency is updated, less if
        // max/maxSize are reached).
        ttl: 1000 * 60 * 60 * 2
    });

    /**
     * Returns the IDs of the screenshots viewed by the given IP address OR
     * optionally by the given creator.
     *
     * @param ipAddress    IP address to filter by.
     * @param creatorId    Optional Creator ID to filter by.
     * @param maxAgeInDays Max age of the views to consider, in days, so we can
     *                     repropose screenshots the user hasn't seen in a
     *                     while. Due to internal caching, a change in the limit
     *                     will not apply until the IP address entry is evicted.
     */
    public async getViewedScreenshotIds(
        ipAddress: IPAddress,
        creatorId: CreatorID | undefined,
        maxAgeInDays: number | undefined
    ): Promise<Screenshot['id'][]> {
        if (this.viewsCache.has(ipAddress)) {
            // biome-ignore lint/style/noNonNullAssertion: cannot be null
            return this.viewsCache.get(ipAddress)!;
        }

        const creator = creatorId
            ? await this.creatorService.getCreator(creatorId)
            : null;

        const screenshots = await this.prisma.view.findMany({
            select: { screenshotId: true },
            where: {
                // biome-ignore lint/style/useNamingConvention: prisma
                AND: [
                    maxAgeInDays
                        ? {
                              viewedAt: {
                                  gte: dateFns.subDays(new Date(), maxAgeInDays)
                              }
                          }
                        : {},
                    creator
                        ? // biome-ignore lint/style/useNamingConvention: prisma
                          { OR: [{ ipAddress }, { creatorId: creator.id }] }
                        : { ipAddress }
                ]
            }
        });

        const screenshotIds = screenshots.map(view => view.screenshotId);

        this.viewsCache.set(ipAddress, screenshotIds);

        return screenshotIds;
    }

    /**
     * Marks a screenshot as viewed:
     * - Increments the view count ({@link Screenshot.views}).
     * - Creates a new {@link View} record.
     */
    public async markViewed(
        screenshotId: Screenshot['id'],
        ipAddress: IPAddress,
        creatorId: CreatorID | undefined
    ): Promise<void> {
        // Add the view to the cache.
        const cachedScreenshotIds = this.viewsCache.get(ipAddress) ?? [];
        cachedScreenshotIds.push(screenshotId);

        this.viewsCache.set(ipAddress, cachedScreenshotIds);

        // Update the Screenshot view count and create a new View record.
        // No transaction, this is not critical data.

        const creator = creatorId
            ? await this.creatorService.getCreator(creatorId)
            : null;

        await this.prisma.screenshot.update({
            select: { id: true },
            where: { id: screenshotId },
            data: { views: { increment: 1 } }
        });

        await this.prisma.view.create({
            data: { screenshotId, ipAddress, creatorId: creator?.id ?? null }
        });
    }
}
