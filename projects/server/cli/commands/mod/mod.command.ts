import type { Provider } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { iconsole } from '../../../../shared/iconsole';
import { ModResyncCommand } from './mod-resync.command';
import { ModSkyveSyncCommand } from './mod-skyve-sync.command';

@Command({
  name: 'mod',
  description: `Commands related to Paradox Mods mods.`,
  subCommands: [ModResyncCommand, ModSkyveSyncCommand]
})
export class ModCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [
    ModCommand,
    ...ModResyncCommand.providers(),
    ...ModSkyveSyncCommand.providers()
  ];

  public override run(): Promise<void> {
    iconsole.error(`Please specify a subcommand.`);

    return Promise.resolve();
  }
}
