import type { Provider } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { iconsole } from '../../../../shared/iconsole';
import { DashboardSyncCommand } from './dashboard-sync.command';

@Command({
  name: 'dashboard',
  description: `Commands related to the Metabase dashboards.`,
  subCommands: [DashboardSyncCommand]
})
export class DashboardCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [
    DashboardCommand,
    ...DashboardSyncCommand.providers()
  ];

  public override run(): Promise<void> {
    iconsole.error(`Please specify a subcommand.`);

    return Promise.resolve();
  }
}
