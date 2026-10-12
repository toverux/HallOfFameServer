import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as sentry from '@sentry/bun';
import { oneLine } from 'common-tags';
import type { Prisma, Screenshot } from '#prisma-lib/client';
import { allFulfilled } from '../../shared/utils/all-fulfilled';
import { config } from '../config';
import { PrismaService } from './prisma.service';

/**
 * The medal a screenshot earns from its exact like rate, see
 * {@link ScreenshotStatsService.getRank}.
 */
export type ScreenshotRank = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';

/**
 * The lowest exact like rate (percentage) of each rank above bronze.
 */
type RankCutPoints = Readonly<Record<Exclude<ScreenshotRank, 'bronze'>, number>>;

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
 *
 * It also holds the thresholds computed from the like rates of all screenshots:
 * the medal rank cut points (see {@link getRank}) and the bar of the "popular" algorithm.
 */
@Injectable()
export class ScreenshotStatsService implements OnApplicationBootstrap {
  /**
   * The percentile of the exact like rate at which each rank above bronze starts.
   * Listed from the highest rank, the order in which {@link getRank} tries them.
   */
  private static readonly rankPercentiles = [
    { rank: 'diamond', percentile: 0.97 },
    { rank: 'platinum', percentile: 0.75 },
    { rank: 'gold', percentile: 0.5 },
    { rank: 'silver', percentile: 0.25 }
  ] as const satisfies ReadonlyArray<{ rank: keyof RankCutPoints; percentile: number }>;

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  private readonly logger = new Logger(ScreenshotStatsService.name);

  private readonly screenshotsToSync = new Set<Screenshot['id']>();

  /**
   * The lowest exact like rate of each rank above bronze, among the screenshots that can be ranked.
   * Computed at startup and by {@link resyncAllCron}.
   */
  private cutPoints: RankCutPoints = { silver: 0, gold: 0, platinum: 0, diamond: 0 };

  private popularThreshold = 0;

  /**
   * The lowest {@link Screenshot.favoritingPercentage} of a "popular" screenshot:
   * the {@link config.screenshots.popularScreenshotsPercentile} percentile among screenshots
   * with at least {@link config.screenshots.popularScreenshotsMinFavorites} likes.
   * Computed with {@link cutPoints}.
   */
  public get popularFavoritingPercentageThreshold(): number {
    return this.popularThreshold;
  }

  public async onApplicationBootstrap(): Promise<void> {
    await this.refreshThresholds();
  }

  /**
   * Ranks a screenshot from its exact like rate against {@link cutPoints}.
   * The rate is computed from the counters rather than read from the rounded
   * {@link Screenshot.favoritingPercentage}, so ties do not merge the ranks.
   *
   * @returns The rank, or null when the screenshot has fewer unique views than
   *   {@link config.screenshots.rankMinUniqueViews} ("settling") or fewer likes than
   *   {@link config.screenshots.rankMinFavorites} ("no medal").
   */
  public getRank(
    screenshot: Pick<Screenshot, 'favoritesCount' | 'uniqueViewsCount'>
  ): ScreenshotRank | null {
    const { favoritesCount, uniqueViewsCount } = screenshot;

    if (
      uniqueViewsCount < config.screenshots.rankMinUniqueViews ||
      favoritesCount < config.screenshots.rankMinFavorites
    ) {
      return null;
    }

    // Same operations in the same order as the cut points aggregation, for equal floats.
    const likeRate = (favoritesCount * 100) / uniqueViewsCount;

    const tier = ScreenshotStatsService.rankPercentiles.find(
      ({ rank }) => likeRate >= this.cutPoints[rank]
    );

    return tier?.rank ?? 'bronze';
  }

  /**
   * Requests an update for the statistics of a specific screenshot by its ID.
   * The update will be performed during the next run of {@link resyncRequestsCron}.
   */
  public requestStatsUpdate(screenshotId: Screenshot['id']): void {
    // oxlint-disable-next-line node/no-sync - screenshotsToSync is a Set field, not an fs sync call
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
    })) as unknown as ReadonlyArray<
      Readonly<{
        _id: Readonly<{ $oid: string }>;
        computedViews: number;
        computedUniqueViews: number;
        computedFavorites: number;
      }>
    >;

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
   * Updating averages can also be done from the CLI with `mise run:cli screenshot resync-stats`.
   */
  @Cron('*/5 * * * *')
  public resyncRequestsCron(): Promise<void> {
    const screenshotIds = new Set(this.screenshotsToSync);

    return this.runCronTask(async () => {
      await this.resyncStats(screenshotIds);

      // Remove synced IDs from the list of IDs to sync.
      for (const id of screenshotIds) {
        // oxlint-disable-next-line node/no-sync - screenshotsToSync is a Set field, not an fs sync call
        this.screenshotsToSync.delete(id);
      }
    });
  }

  /**
   * Resync stats for all screenshots at 00:02, then the thresholds from the fresh counters.
   * We do it with an offset to avoid clashes with {@link resyncRequestsCron}.
   */
  @Cron('2 0 * * *')
  public resyncAllCron(): Promise<void> {
    return this.runCronTask(async () => {
      await this.resyncStats();
      await this.refreshThresholds();
    });
  }

  private async runCronTask(task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.logger.error(`Failed CRON update of screenshot stats.`, error);

      sentry.captureException(error);
    }
  }

  /**
   * Computes {@link cutPoints} and {@link popularFavoritingPercentageThreshold}
   * in one aggregation, each over its own population.
   */
  private async refreshThresholds(): Promise<void> {
    const { rankPercentiles } = ScreenshotStatsService;

    const [result] = (await this.prisma.screenshot.aggregateRaw({
      pipeline: [
        {
          $facet: {
            ranks: percentileFacet(
              {
                uniqueViewsCount: { $gte: config.screenshots.rankMinUniqueViews },
                favoritesCount: { $gte: config.screenshots.rankMinFavorites }
              },
              // Same operations in the same order as getRank, for equal floats.
              { $divide: [{ $multiply: ['$favoritesCount', 100] }, '$uniqueViewsCount'] },
              rankPercentiles.map(({ percentile }) => percentile)
            ),
            popular: percentileFacet(
              { favoritesCount: { $gte: config.screenshots.popularScreenshotsMinFavorites } },
              '$favoritingPercentage',
              [config.screenshots.popularScreenshotsPercentile]
            )
          }
        }
      ]
    })) as unknown as ReadonlyArray<Record<'ranks' | 'popular', readonly PercentileFacetResult[]>>;

    // A facet has no result if nothing matches (empty or new database).
    const cutPoints = result?.ranks[0]?.percentiles;

    this.cutPoints = Object.fromEntries(
      rankPercentiles.map(({ rank }, index) => [rank, cutPoints?.[index] ?? 0])
    ) as RankCutPoints;

    this.popularThreshold = result?.popular[0]?.percentiles[0] ?? 0;

    this.logger.log(
      oneLine`
      Rank cut points (like rate):
      ${rankPercentiles.map(({ rank }) => `${rank} ${this.cutPoints[rank].toFixed(2)}%`).join(', ')}
      (min unique views=${config.screenshots.rankMinUniqueViews},
      min favorites=${config.screenshots.rankMinFavorites}).
      Popular screenshots favoriting percentage threshold: ${this.popularThreshold}%
      (percentile=${config.screenshots.popularScreenshotsPercentile},
      min favorites=${config.screenshots.popularScreenshotsMinFavorites}).`
    );
  }
}

interface PercentileFacetResult {
  readonly percentiles: readonly number[];
}

/**
 * A `$facet` pipeline computing the given percentiles of {@link input}
 * over the screenshots matching {@link match}, as one {@link PercentileFacetResult}.
 */
function percentileFacet(
  match: Prisma.InputJsonObject,
  input: Prisma.InputJsonValue,
  percentiles: readonly number[]
): Prisma.InputJsonObject[] {
  return [
    { $match: match },
    {
      $group: {
        _id: null,
        // oxlint-disable-next-line id-length
        percentiles: { $percentile: { input, p: percentiles, method: 'approximate' } }
      }
    }
  ];
}
