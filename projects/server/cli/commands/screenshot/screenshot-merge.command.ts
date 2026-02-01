import { Inject, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { oneLine } from 'common-tags';
import { CommandRunner, SubCommand } from 'nest-commander';
import { iconsole } from '../../../../shared/iconsole';
import { ScreenshotMergingService } from '../../../services';

@SubCommand({
  name: 'merge',
  arguments: '<targetId> <sourceId...>',
  description: oneLine`
    Merge screenshots, to target from sources. The target gets the favorites, views, etc, that the
    sources have and that the target does not already have. The source is deleted.`
})
export class ScreenshotMergeCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [ScreenshotMergeCommand];

  @Inject(ScreenshotMergingService)
  private readonly screenshotMergingService!: ScreenshotMergingService;

  public override async run(args: [string, ...string[]]): Promise<void> {
    const [targetId, ...sourceIds] = args;

    // Already does info logging, no need to repeat.
    await this.screenshotMergingService.mergeScreenshots(targetId, sourceIds);

    iconsole.info(chalk.bold(`Done.`));
  }
}
