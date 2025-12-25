import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as sentry from '@sentry/bun';
import type { Prisma, Screenshot } from '#prisma-lib/client';
import { allFulfilled } from '../../shared/utils/all-fulfilled';
import { PrismaService } from './prisma.service';

/**
 * A service responsible for managing and updating screenshot statistics that are costly/hazardous
 * to maintain in realtime:
 * - {@link Screenshot.viewsCount}
 * - {@link Screenshot.uniqueViewsCount}
 * - {@link Screenshot.favoritesCount}
 * - {@link Screenshot.favoritingPercentage}
 *
 * It provides methods for requesting and performing stats synchronization as well as
 * scheduled tasks to handle periodic updates.
 */
@Injectable()
export class ScreenshotStatsService {
  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  private readonly logger = new Logger(ScreenshotStatsService.name);

  private readonly screenshotsToSync = new Set<Screenshot['id']>();

  /**
   * Requests an update for the statistics of a specific screenshot by its ID.
   * The update will be performed during the next run of {@link resyncRequestsCron}.
   */
  public requestStatsUpdate(screenshotId: Screenshot['id']): void {
    this.screenshotsToSync.add(screenshotId);
  }

  /**
   * Immediately synchronizes the statistics for the specified screenshots, or all screenshots if
   * {@link screenshotIds} is not passed.
   */
  public async resyncStats(
    screenshotIds?: ReadonlySet<Screenshot['id']>,
    prisma: Prisma.TransactionClient = this.prisma
  ): Promise<void> {
    if (screenshotIds?.size == 0) {
      return this.logger.verbose(`No screenshots to resync.`);
    }

    this.logger.log(
      `Resyncing screenshot stats for ${screenshotIds ? `up to ${screenshotIds.size}` : 'all'} screenshots.`
    );

    const pipeline = [
      {
        $match: screenshotIds
          ? { _id: { $in: Array.from(screenshotIds).map(id => ({ $oid: id })) } }
          : {}
      },
      {
        $lookup: {
          from: 'views',
          localField: '_id',
          foreignField: 'screenshotId',
          as: 'viewsLookup'
        }
      },
      {
        $lookup: {
          from: 'views',
          localField: '_id',
          foreignField: 'screenshotId',
          as: 'uniqueViewsLookup',
          pipeline: [{ $group: { _id: '$creatorId' } }]
        }
      },
      {
        $lookup: {
          from: 'favorites',
          localField: '_id',
          foreignField: 'screenshotId',
          as: 'favoritesLookup'
        }
      },
      {
        $addFields: {
          computedViews: { $size: '$viewsLookup' },
          computedUniqueViews: { $size: '$uniqueViewsLookup' },
          computedFavorites: { $size: '$favoritesLookup' }
        }
      },
      {
        $match: {
          $or: [
            { $expr: { $ne: ['$viewsCount', '$computedViews'] } },
            { $expr: { $ne: ['$uniqueViewsCount', '$computedUniqueViews'] } },
            { $expr: { $ne: ['$favoritesCount', '$computedFavorites'] } }
          ]
        }
      },
      {
        $project: { _id: 1, computedViews: 1, computedUniqueViews: 1, computedFavorites: 1 }
      }
    ];

    const results = (await prisma.screenshot.aggregateRaw({
      pipeline
    })) as unknown as readonly Readonly<{
      _id: Readonly<{ $oid: string }>;
      computedViews: number;
      computedUniqueViews: number;
      computedFavorites: number;
    }>[];

    this.logger.verbose(`Found ${results.length} screenshot(s) needing to be updated.`);

    if (!results.length) {
      return;
    }
    const updateOps = results.map(result =>
      prisma.screenshot.update({
        where: { id: result._id.$oid },
        data: {
          viewsCount: result.computedViews,
          uniqueViewsCount: result.computedUniqueViews,
          favoritesCount: result.computedFavorites,
          favoritingPercentage: result.computedUniqueViews
            ? Math.round((result.computedFavorites / result.computedUniqueViews) * 100)
            : 0
        }
      })
    );

    // Updating all at once, there shouldn't ever be too many screenshots. Even during a migration,
    // the database has been fine taking 8k+ requests simultaneously.
    await allFulfilled(updateOps);

    this.logger.log(`Updated stats for ${updateOps.length} screenshot(s).`);
  }

  /**
   * Resync stats every five minutes with the screenshots that have been marked as liked or viewed.
   * Updating averages can also be done from the CLI with `bun run:cli screenshot resync-stats`.
   */
  @Cron('*/5 * * * *')
  public resyncRequestsCron(): Promise<void> {
    return this.doCronUpdate(new Set(this.screenshotsToSync));
  }

  /**
   * Resync stats for all screenshots at 00:02. We do it with an offset to avoid clashes with
   * {@link resyncRequestsCron}.
   */
  @Cron('2 0 * * *')
  public resyncAllCron(): Promise<void> {
    return this.doCronUpdate();
  }

  private async doCronUpdate(screenshotIds?: ReadonlySet<Screenshot['id']>): Promise<void> {
    try {
      await this.resyncStats(screenshotIds);

      // Remove synced IDs from the list of IDs to sync.
      if (screenshotIds) {
        for (const id of screenshotIds) {
          this.screenshotsToSync.delete(id);
        }
      }
    } catch (error) {
      this.logger.error(`Failed CRON update of screenshot stats.`, error);

      sentry.captureException(error);
    }
  }
}
