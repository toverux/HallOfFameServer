import { Inject, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { CommandRunner, SubCommand } from 'nest-commander';
import { iconsole } from '../../../../shared/iconsole';
import { ModService } from '../../../services';

@SubCommand({
  name: 'resync',
  description: `Refreshes every mod from Paradox Mods, and un-retires the ones retired on a transient error.`
})
export class ModResyncCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [ModResyncCommand];

  @Inject(ModService)
  private readonly modService!: ModService;

  public override async run(): Promise<void> {
    const { refreshed, unretired, retired, failed } = await this.modService.resyncAll();

    iconsole.info(
      chalk.bold(
        `Done: ${refreshed} refreshed, ${unretired} un-retired, ${retired} retired, ${failed} failed.`
      )
    );
  }
}
