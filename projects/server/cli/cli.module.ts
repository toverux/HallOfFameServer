import { Module } from '@nestjs/common';
import type { Command } from 'commander';
import { InjectCommander } from 'nest-commander';
import { SharedModule } from '../shared.module';
import { commands } from './commands';

@Module({
  providers: commands,
  imports: [SharedModule]
})
export class CliModule {
  public constructor(@InjectCommander() commander: Command) {
    commander.option('-v, --verbose', 'Enable all logging levels.');
  }
}
