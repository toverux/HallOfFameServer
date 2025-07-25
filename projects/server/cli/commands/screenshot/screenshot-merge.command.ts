import { Inject, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { oneLine } from 'common-tags';
import { CommandRunner, SubCommand } from 'nest-commander';
import type { Favorite, Prisma, View } from '../../../../../prisma/generated/client';
import { iconsole } from '../../../iconsole';
import { PrismaService, ScreenshotService } from '../../../services';

@SubCommand({
  name: 'merge',
  arguments: '<targetId> <sourceId...>',
  description: oneLine`
    Merge screenshots, to target from sources. The target gets the favorites, views, etc, that the
    sources have and that the target does not already have. The source is deleted.`
})
export class ScreenshotMergeCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [ScreenshotMergeCommand];

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(ScreenshotService)
  private readonly screenshotService!: ScreenshotService;

  public override async run(args: [string, ...string[]]): Promise<void> {
    const [targetId, ...sourceIds] = args;

    await this.prisma.$transaction(async prisma => {
      await this.mergeFavorites(prisma, targetId, sourceIds);
      await this.mergeViews(prisma, targetId, sourceIds);
      await this.deleteSourceScreenshots(prisma, sourceIds);
      await this.updateScreenshotStats(prisma, targetId);
    });
  }

  private async mergeFavorites(
    prisma: Prisma.TransactionClient,
    targetId: string,
    sourceIds: string[]
  ): Promise<void> {
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
      await prisma.favorite.createMany({
        data: deduplicatedFavorites
      });
    }

    iconsole.info(
      chalk.bold(
        `Merged ${deduplicatedFavorites.length} favorite(s), removed ${allFavorites.length - deduplicatedFavorites.length} duplicate(s).`
      )
    );
  }

  private async mergeViews(
    prisma: Prisma.TransactionClient,
    targetId: string,
    sourceIds: string[]
  ): Promise<void> {
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
      await prisma.view.createMany({
        data: deduplicatedViews
      });
    }

    iconsole.info(
      chalk.bold(
        `Merged ${deduplicatedViews.length} views(s), removed ${allViews.length - deduplicatedViews.length} duplicate(s).`
      )
    );
  }

  private async deleteSourceScreenshots(
    prisma: Prisma.TransactionClient,
    sourceIds: string[]
  ): Promise<void> {
    const sources = await prisma.screenshot.findMany({
      where: { id: { in: sourceIds } }
    });

    for (const source of sources) {
      await this.screenshotService.deleteScreenshot(source.id, prisma);
    }

    iconsole.info(chalk.bold(`Deleted ${sources.length} source screenshot(s).`));
  }

  private async updateScreenshotStats(
    prisma: Prisma.TransactionClient,
    targetId: string
  ): Promise<void> {
    const viewsCount = await prisma.view.count({
      where: { screenshotId: targetId }
    });

    const favoritesCount = await prisma.favorite.count({
      where: { screenshotId: targetId }
    });

    await prisma.screenshot.update({
      where: { id: targetId },
      data: { favoritesCount, viewsCount }
    });

    await this.screenshotService.updateAverageViewsAndFavoritesPerDay({
      prisma,
      screenshotId: targetId
    });

    iconsole.info(chalk.bold(`Updated target screenshot stats.`));
  }
}
