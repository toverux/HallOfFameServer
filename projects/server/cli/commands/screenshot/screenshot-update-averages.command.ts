import { Inject, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { CommandRunner, SubCommand } from 'nest-commander';
import { iconsole } from '../../../iconsole';
import { ScreenshotService } from '../../../services';

@SubCommand({
  name: 'update-averages',
  description: `Update average view and favorites per day for each screenshot.`
})
export class ScreenshotUpdateAveragesCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [ScreenshotUpdateAveragesCommand];

  @Inject(ScreenshotService)
  private readonly screenshotService!: ScreenshotService;

  public override async run(): Promise<void> {
    await this.screenshotService.updateAverageViewsAndFavoritesPerDay({ nice: false });

    iconsole.info(chalk.bold(`Done.`));
  }
}
