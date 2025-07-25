import { Inject, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { CommandRunner, SubCommand } from 'nest-commander';
import { iconsole } from '../../../iconsole';
import { ScreenshotService } from '../../../services';

@SubCommand({
  name: 'delete',
  arguments: '<id>',
  description: `Delete a screenshot from the database and blob storage.`
})
export class ScreenshotDeleteCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [ScreenshotDeleteCommand];

  @Inject(ScreenshotService)
  private readonly screenshotService!: ScreenshotService;

  public override async run(args: [string]): Promise<void> {
    const [id] = args;

    await this.screenshotService.deleteScreenshot(id);

    iconsole.info(chalk.bold(`Screenshot ${id} deleted successfully!`));
  }
}
