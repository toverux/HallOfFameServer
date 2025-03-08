import { Provider } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { DeleteCreatorCommand } from './delete-creator';
import { DeleteScreenshotCommand } from './delete-screenshot';

@Command({
  name: 'delete',
  description: `Command for deletion of various resources.`,
  subCommands: [DeleteScreenshotCommand, DeleteCreatorCommand]
})
class DeleteCommand extends CommandRunner {
  public override run(): Promise<void> {
    console.info(`Please specify a subcommand.`);

    return Promise.resolve();
  }
}

export const deleteCommandProviders: Provider[] = [DeleteCommand];
