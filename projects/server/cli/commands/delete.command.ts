import { Provider } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { DeleteScreenshotCommand } from './delete-screenshot';

@Command({
    name: 'delete',
    description: `Command for deletion of various resources.`,
    subCommands: [DeleteScreenshotCommand]
})
class DeleteCommand extends CommandRunner {
    public override run(): Promise<void> {
        process.stdout.write(`Please specify a subcommand.\n`);

        return Promise.resolve();
    }
}

export const deleteCommandProviders: Provider[] = [DeleteCommand];
