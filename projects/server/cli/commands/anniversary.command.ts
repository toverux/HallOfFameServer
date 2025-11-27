import fs from 'node:fs/promises';
import path from 'node:path';
import { Inject, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { oneLine } from 'common-tags';
import { format } from 'date-fns';
import { Command, CommandRunner, Option } from 'nest-commander';
import open from 'open';
import type { Creator, Screenshot } from '#prisma-lib/client';
import { iconsole } from '../../../shared/iconsole';
import { nn } from '../../../shared/utils';
import { PrismaService, ScreenshotStorageService } from '../../services';

@Command({
  name: 'anniversary',
  description: `Downloads Hall of Fame best cities' pictures for anniversary post.`
})
export class AnniversaryCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [AnniversaryCommand];

  @Option({
    flags: '--count [number]',
    description: `How many city renders to generate.`,
    defaultValue: 40
  })
  public parseCount(val: string): number {
    return Number.parseInt(val, 10);
  }

  @Option({
    flags: '--open [boolean]',
    description: `Opens the output folder using the default app.`,
    required: false
  })
  public parseOpen(val: string): boolean {
    return JSON.parse(val);
  }

  private static readonly outputPath = path.join(
    import.meta.dir,
    '../../../../.output/anniversary'
  );

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(ScreenshotStorageService)
  private readonly screenshotStorage!: ScreenshotStorageService;

  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: simple linear cli flow
  public override async run(
    _args: [],
    options: Readonly<{ count: number; open: boolean }>
  ): Promise<void> {
    const screenshots = await this.prisma.screenshot.findMany({
      include: { creator: { select: { creatorName: true } } }
    });

    const citiesByName = new Map<
      `${Creator['id']}_${Screenshot['cityName']}`,
      (typeof screenshots)[number][]
    >();

    for (const screenshot of screenshots) {
      const cityName = screenshot.cityName.split(',').at(0);

      const cityId = `${screenshot.creatorId}_${cityName}` as const;

      const cityScreenshots = citiesByName.get(cityId) ?? [];
      cityScreenshots.push(screenshot);

      citiesByName.set(cityId, cityScreenshots);
    }

    iconsole.log(`Found ${citiesByName.size} cities.`);

    const citiesRecap = Array.from(citiesByName.values())
      .map(screenshots => {
        const screenshotsOrderedByFavoritingRatio = screenshots.toSorted(
          (a, b) => b.favoritesCount / b.uniqueViewsCount - a.favoritesCount / a.uniqueViewsCount
        );

        const screenshotsOrderedByDate = screenshots.toSorted(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
        );

        const firstSeenAt = nn(screenshotsOrderedByDate.at(0)).createdAt;
        const lastSeenAt = nn(screenshotsOrderedByDate.at(-1)).createdAt;

        const favoritesCount = screenshots.reduce((count, s) => count + s.favoritesCount, 0);

        const medianLikeRatio = (() => {
          const sorted = screenshots
            .map(s => s.favoritesCount / s.uniqueViewsCount)
            .sort((a, b) => a - b);

          const middle = Math.floor(sorted.length / 2);

          return sorted.length % 2 == 0
            ? // biome-ignore lint/style/noNonNullAssertion: cannot be null
              (sorted[middle - 1]! + sorted[middle]!) / 2
            : // biome-ignore lint/style/noNonNullAssertion: cannot be null
              sorted[middle]!;
        })();

        const firstScreenshot = nn(screenshots[0]);

        return {
          screenshots: screenshotsOrderedByFavoritingRatio,
          creatorName: firstScreenshot.creator.creatorName,
          cityName: firstScreenshot.cityName,
          favoritesCount,
          firstSeenAt,
          lastSeenAt,
          medianLikeRatio
        };
      })
      .filter(recap => recap.screenshots.length >= 4)
      .sort((a, b) => b.medianLikeRatio - a.medianLikeRatio)
      .slice(0, options.count);

    await fs.rm(AnniversaryCommand.outputPath, { recursive: true, force: true });

    await fs.mkdir(AnniversaryCommand.outputPath, { recursive: true });

    if (options.open) {
      await open(AnniversaryCommand.outputPath, { wait: false });
    }

    for (let cityIndex = 0; cityIndex < citiesRecap.length; cityIndex++) {
      const city = nn(citiesRecap[cityIndex]);

      iconsole.info(
        oneLine`
        🏙️ Processing city ${chalk.bold(city.cityName)},
        ${cityIndex + 1} of ${citiesRecap.length}...`
      );

      for (let screenshotIndex = 0; screenshotIndex < city.screenshots.length; screenshotIndex++) {
        const screenshot = nn(city.screenshots[screenshotIndex]);

        iconsole.info(
          oneLine`
          📸 Downloading ${chalk.bold(city.cityName)},
          screenshot ${screenshotIndex + 1} of ${city.screenshots.length}...`
        );

        const cityPath = path.join(
          AnniversaryCommand.outputPath,
          oneLine`
          ${cityIndex + 1}. ${city.cityName} by
          ${city.creatorName},
          ${city.favoritesCount} likes
          (${(Math.round(city.medianLikeRatio * 100)).toFixed(1)}%),
          ${format(city.firstSeenAt, 'MMM yy')}-${format(city.lastSeenAt, 'MMM yy')}`
        );

        await fs.mkdir(cityPath, { recursive: true });

        const screenshotPath = path.join(
          cityPath,
          oneLine`
          ${screenshotIndex + 1}. ${screenshot.id},
          ${screenshot.favoritesCount} likes (${screenshot.favoritingPercentage}%).jpg`
        );

        await this.screenshotStorage.downloadScreenshotToFile(
          screenshot.imageUrl4K,
          screenshotPath
        );
      }

      iconsole.info(chalk.bold(`Done.`));
    }
  }
}
