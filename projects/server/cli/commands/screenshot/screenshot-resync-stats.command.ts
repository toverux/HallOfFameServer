import { Inject, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { CommandRunner, SubCommand } from 'nest-commander';
import { iconsole } from '../../../../shared/iconsole';
import { ScreenshotStatsService } from '../../../services';

@SubCommand({
  name: 'resync-stats',
  description: `Recomputes the favorites/view count and favoriting percentage of every screenshot.`
})
export class ScreenshotResyncStatsCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [ScreenshotResyncStatsCommand];

  @Inject(ScreenshotStatsService)
  private readonly screenshotStatsService!: ScreenshotStatsService;

  public override async run(): Promise<void> {
    await this.screenshotStatsService.resyncStats();

    iconsole.info(chalk.bold(`Done.`));
  }
}
