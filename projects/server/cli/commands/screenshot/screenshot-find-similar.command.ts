import { Inject, Provider } from '@nestjs/common';
import { Screenshot } from '@prisma/client';
import chalk from 'chalk';
import { CommandRunner, Option, SubCommand } from 'nest-commander';
import {
  PrismaService,
  ScreenshotService,
  ScreenshotSimilarityDetectorService
} from '../../../services';

@SubCommand({
  name: 'find-similar',
  description: `Find screenshots that are semantically close to each other.`
})
export class ScreenshotFindSimilarCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [ScreenshotFindSimilarCommand];

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(ScreenshotService)
  private readonly screenshotService!: ScreenshotService;

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
      // biome-ignore lint/style/useThrowOnlyError: normal pattern w/Commander
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

    for (const screenshot of screenshots) {
      if (alreadyReportedIds.has(screenshot.id)) {
        continue;
      }

      const matchesIterator = this.imageSimilarityDetector.findSimilarScreenshots(
        { id: screenshot.id, imageUrlOrBuffer: screenshot.imageUrlFHD },
        options.distance
      );

      const rawMatches = await Array.fromAsync(matchesIterator);

      const matches = [{ screenshotId: screenshot.id, distance: 0 }]
        .concat(rawMatches)
        .map(({ screenshotId, distance }) => {
          // biome-ignore lint/style/noNonNullAssertion: should not be allowed to happen.
          const screenshot = screenshots.find(candidate => candidate.id == screenshotId)!;

          return { screenshot, distance };
        })
        .filter(match => match.screenshot.creator.id == screenshot.creator.id);

      if (matches.length <= 1) {
        continue;
      }

      for (const match of matches) {
        alreadyReportedIds.add(match.screenshot.id);
      }

      console.table(
        matches.map(({ screenshot, distance }) => ({
          '↔': distance.toFixed(3),
          'id': screenshot.id,
          'city': screenshot.cityName,
          'creator': screenshot.creator.creatorName,
          'favorites': screenshot.favoritesCount,
          'url': this.screenshotService.getBlobUrl(screenshot.imageUrlFHD)
        }))
      );
    }

    console.info(chalk.bold(`Found ${alreadyReportedIds.size} similar images.`));
  }
}
