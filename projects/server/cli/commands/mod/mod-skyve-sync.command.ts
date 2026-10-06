import { Inject, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { CommandRunner, SubCommand } from 'nest-commander';
import { iconsole } from '../../../../shared/iconsole';
import { SkyveService } from '../../../services';

@SubCommand({
  name: 'skyve-sync',
  description: `Syncs Skyve's compatibility verdicts on mods now, as the daily cron does.`
})
export class ModSkyveSyncCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [ModSkyveSyncCommand];

  @Inject(SkyveService)
  private readonly skyveService!: SkyveService;

  public override async run(): Promise<void> {
    const changed = await this.skyveService.syncCompatibilityData();

    iconsole.info(chalk.bold(`Done: ${changed} verdicts changed.`));
  }
}
