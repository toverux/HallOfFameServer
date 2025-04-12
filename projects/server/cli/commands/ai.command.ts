import { Provider } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { AiTranslateCitiesCommand } from './ai-translate-cities.command';
import { AiTranslateCreatorsCommand } from './ai-translate-creators.command';

@Command({
  name: 'ai',
  description: `Execute AI tasks.`,
  subCommands: [AiTranslateCitiesCommand, AiTranslateCreatorsCommand]
})
class AiCommand extends CommandRunner {
  public override run(): Promise<void> {
    console.info(`Please specify a subcommand.`);

    return Promise.resolve();
  }
}

export const aiCommandProviders: Provider[] = [AiCommand];
