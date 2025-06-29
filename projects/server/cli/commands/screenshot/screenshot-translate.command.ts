import { Inject, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { oneLine, stripIndent } from 'common-tags';
import { CommandRunner, SubCommand } from 'nest-commander';
import { iconsole } from '../../../iconsole';
import { PrismaService, ScreenshotService } from '../../../services';

@SubCommand({
  name: 'translate',
  description: `Translate all city names that have not been translated yet.`
})
export class ScreenshotTranslateCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [ScreenshotTranslateCommand];

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(ScreenshotService)
  private readonly screenshotService!: ScreenshotService;

  public override async run(): Promise<void> {
    const screenshots = await this.prisma.screenshot.findMany({
      where: { needsTranslation: true },
      select: { id: true, creatorId: true, cityName: true }
    });

    iconsole.info(chalk.bold`Found ${screenshots.length} screenshots to process.`);

    let translatedCount = 0;
    let translatedCachedCount = 0;

    for (const screenshot of screenshots) {
      const result = await this.screenshotService.updateCityNameTranslation(screenshot);

      if (!result.translated) {
        continue;
      }

      translatedCount++;

      let message = oneLine`
        ${chalk.bold(result.screenshot.cityName)} (${result.screenshot.cityNameLocale})
        → ${result.screenshot.cityNameLatinized}
        → ${result.screenshot.cityNameTranslated}`;

      if (result.cached) {
        translatedCachedCount++;
        message = chalk.dim`${message} (cached)`;
      }

      iconsole.info(message);
    }

    iconsole.info(
      stripIndent`
      ${chalk.bold`Done processing ${screenshots.length} screenshots.`}
      Translated ${translatedCount} screenshots ${chalk.dim`(${translatedCachedCount} cached)`}.`
    );
  }
}
