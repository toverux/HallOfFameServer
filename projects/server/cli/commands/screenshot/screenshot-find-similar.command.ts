import { Inject, type Provider } from '@nestjs/common';
import type { Screenshot } from '@prisma/client';
import chalk from 'chalk';
import { CommandRunner, Option, SubCommand } from 'nest-commander';
import { iconsole } from '../../../iconsole';
import {
  PrismaService,
  ScreenshotSimilarityDetectorService,
  ScreenshotStorageService
} from '../../../services';

@SubCommand({
  name: 'find-similar',
  description: `Find screenshots that are semantically close to each other.`
})
export class ScreenshotFindSimilarCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [ScreenshotFindSimilarCommand];

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(ScreenshotStorageService)
  private readonly screenshotStorage!: ScreenshotStorageService;

  @Inject(ScreenshotSimilarityDetectorService)
  private readonly imageSimilarityDetector!: ScreenshotSimilarityDetectorService;

  @Option({
    flags: '-d, --distance [number]',
    description: `Maximum distance between screenshots to consider them similar (default 0.05 = very similar).`,
    defaultValue: 0.05
  })
  public parseDistance(val: string): number {
    const distance = Number.parseFloat(val);

    if (distance < 0 || distance > 1 || Number.isNaN(distance)) {
      throw `Distance must be between 0 and 1, got ${distance}.`;
    }

    return distance;
  }

  public override async run(_args: never, options: { readonly distance: number }): Promise<void> {
    const screenshots = await this.prisma.screenshot.findMany({
      select: {
        id: true,
        cityName: true,
        imageUrlFHD: true,
        favoritesCount: true,
        creator: { select: { id: true, creatorName: true } }
      }
    });

    const alreadyReportedIds = new Set<Screenshot['id']>();

    for (const sourceScreenshot of screenshots) {
      if (alreadyReportedIds.has(sourceScreenshot.id)) {
        continue;
      }

      const matchesIterator = this.imageSimilarityDetector.findSimilarScreenshots(
        { id: sourceScreenshot.id, imageUrlOrBuffer: sourceScreenshot.imageUrlFHD },
        options.distance
      );

      const rawMatches = await Array.fromAsync(matchesIterator);

      const matches = [{ screenshotId: sourceScreenshot.id, distance: 0 }]
        .concat(rawMatches)
        .map(({ screenshotId, distance }) => {
          // biome-ignore lint/style/noNonNullAssertion: should not be allowed to happen.
          const screenshot = screenshots.find(candidate => candidate.id == screenshotId)!;

          return { screenshot, distance };
        })
        .filter(match => match.screenshot.creator.id == sourceScreenshot.creator.id);

      if (matches.length <= 1) {
        continue;
      }

      for (const match of matches) {
        alreadyReportedIds.add(match.screenshot.id);
      }

      iconsole.table(
        matches.map(({ screenshot, distance }) => ({
          '↔': distance.toFixed(3),
          'id': screenshot.id,
          'city': screenshot.cityName,
          'creator': screenshot.creator.creatorName,
          'favorites': screenshot.favoritesCount,
          'url': this.screenshotStorage.getScreenshotUrl(screenshot.imageUrlFHD)
        }))
      );
    }

    iconsole.info(chalk.bold(`Found ${alreadyReportedIds.size} similar images.`));
  }
}
