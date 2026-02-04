import type { Provider } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { iconsole } from '../../../../shared/iconsole';
import { ModerateMergeCommand } from './moderate-merge.command';
import { ModerateReportsCommand } from './moderate-reports.command';
import { ModerateShowcasedModsCommand } from './moderate-showcased-mods.command';

/** @public */
@Command({
  name: 'moderate',
  description: `Commands related to moderating screenshots.`,
  subCommands: [ModerateMergeCommand, ModerateReportsCommand, ModerateShowcasedModsCommand]
})
export class ModerateCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [
    ModerateCommand,
    ...ModerateMergeCommand.providers(),
    ...ModerateReportsCommand.providers(),
    ...ModerateShowcasedModsCommand.providers()
  ];

  public override run(): Promise<void> {
    iconsole.error(`Please specify a subcommand.`);

    return Promise.resolve();
  }
}
