import { Inject, Injectable, Logger } from '@nestjs/common';
import { oneLine } from 'common-tags';
import type { Favorite, Prisma, View } from '#prisma-lib/client';
import { allFulfilled } from '../../shared/utils/all-fulfilled';
import { PrismaService } from './prisma.service';
import { ScreenshotService } from './screenshot.service';
import { ScreenshotStatsService } from './screenshot-stats.service';

/**
 * Service responsible for merging screenshots and their associated data.
 * This includes favorites and views associated with the screenshots.
 */
@Injectable()
export class ScreenshotMergingService {
  private readonly logger = new Logger(ScreenshotMergingService.name);

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(ScreenshotService)
  private readonly screenshotService!: ScreenshotService;

  @Inject(ScreenshotStatsService)
  private readonly screenshotStatsService!: ScreenshotStatsService;

  /**
   * Merge screenshots to target from sources.
   * The target gets the favorites and views that the sources have that the target does not already
   * have.
   * The sources are then deleted.
   */
  public mergeScreenshots(
    targetId: string,
    sourceIds: string[]
  ): Promise<{
    mergedFavoritesCount: number;
    deletedFavoritesCount: number;
    mergedViewsCount: number;
    deletedViewsCount: number;
  }> {
    return this.prisma.$transaction(async prisma => {
      const { mergedCount: mergedFavoritesCount, deletedCount: deletedFavoritesCount } =
        await this.mergeFavorites(prisma, targetId, sourceIds);

      const { mergedCount: mergedViewsCount, deletedCount: deletedViewsCount } =
        await this.mergeViews(prisma, targetId, sourceIds);

      await this.deleteSourceScreenshots(prisma, sourceIds);

      await this.screenshotStatsService.resyncStats(new Set([targetId]), prisma);

      this.logger.log(
        oneLine`
        Merged screenshots [${sourceIds.map(id => `#${id}`).join(', ')}] to #${targetId}:
        ${mergedFavoritesCount} favorites, ${deletedFavoritesCount} duplicates deleted,
        ${mergedViewsCount} views, ${deletedViewsCount} duplicates deleted.`
      );

      return { mergedFavoritesCount, deletedFavoritesCount, mergedViewsCount, deletedViewsCount };
    });
  }

  /**
   * Merges favorites from multiple source IDs into a target ID, deduplicating by Creator ID, HWID,
   * and IP, and retaining the earliest favorite date when duplicates exist.
   */
  private async mergeFavorites(
    prisma: Prisma.TransactionClient,
    targetId: string,
    sourceIds: string[]
  ): Promise<{ mergedCount: number; deletedCount: number }> {
    const allFavorites = await prisma.favorite.findMany({
      where: { screenshotId: { in: [targetId, ...sourceIds] } }
    });

    const deduplicatedFavorites = allFavorites.reduce<Favorite[]>((deduplicated, favorite) => {
      const existing = deduplicated.find(
        candidate =>
          candidate.creatorId == favorite.creatorId ||
          candidate.hwid == favorite.hwid ||
          candidate.ip == favorite.ip
      );

      if (existing) {
        if (favorite.favoritedAt < existing.favoritedAt) {
          existing.favoritedAt = favorite.favoritedAt;
        }
      } else {
        deduplicated.push({ ...favorite, screenshotId: targetId });
      }

      return deduplicated;
    }, []);

    await prisma.favorite.deleteMany({
      where: { screenshotId: { in: [targetId, ...sourceIds] } }
    });

    if (deduplicatedFavorites.length > 0) {
      await prisma.favorite.createMany({ data: deduplicatedFavorites });
    }

    const mergedCount = deduplicatedFavorites.length;
    const deletedCount = allFavorites.length - deduplicatedFavorites.length;

    return { mergedCount, deletedCount };
  }

  /**
   * Merges views from multiple source screenshot IDs into a target screenshot ID, deduplicating by
   * creator ID and retaining the earliest `viewedAt` timestamp for duplicate entries.
   */
  private async mergeViews(
    prisma: Prisma.TransactionClient,
    targetId: string,
    sourceIds: string[]
  ): Promise<{ mergedCount: number; deletedCount: number }> {
    const allViews = await prisma.view.findMany({
      where: { screenshotId: { in: [targetId, ...sourceIds] } }
    });

    const deduplicatedViews = allViews.reduce<View[]>((deduplicated, view) => {
      const existing = deduplicated.find(candidate => candidate.creatorId == view.creatorId);

      if (existing) {
        if (view.viewedAt < existing.viewedAt) {
          existing.viewedAt = view.viewedAt;
        }
      } else {
        deduplicated.push({ ...view, screenshotId: targetId });
      }

      return deduplicated;
    }, []);

    await prisma.view.deleteMany({
      where: { screenshotId: { in: [targetId, ...sourceIds] } }
    });

    if (deduplicatedViews.length > 0) {
      await prisma.view.createMany({ data: deduplicatedViews });
    }

    const mergedCount = deduplicatedViews.length;
    const deletedCount = allViews.length - deduplicatedViews.length;

    return { mergedCount, deletedCount };
  }

  private async deleteSourceScreenshots(
    prisma: Prisma.TransactionClient,
    sourceIds: string[]
  ): Promise<void> {
    await allFulfilled(
      sourceIds.map(sourceId => this.screenshotService.deleteScreenshot(sourceId, prisma))
    );
  }
}
