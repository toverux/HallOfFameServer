import type { Provider } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { iconsole } from '../../../iconsole';
import { CreatorDeleteCommand } from './creator-delete.command';
import { CreatorMergeCommand } from './creator-merge.command';
import { CreatorTranslateCommand } from './creator-translate.command';

@Command({
  name: 'creator',
  description: `Commands related to creators.`,
  subCommands: [CreatorDeleteCommand, CreatorMergeCommand, CreatorTranslateCommand]
})
export class CreatorCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [
    CreatorCommand,
    ...CreatorDeleteCommand.providers(),
    ...CreatorMergeCommand.providers(),
    ...CreatorTranslateCommand.providers()
  ];

  public override run(): Promise<void> {
    iconsole.error(`Please specify a subcommand.`);

    return Promise.resolve();
  }
}
