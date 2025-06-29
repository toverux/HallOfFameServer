import type { Provider } from '@nestjs/common';
import { CreatorCommand } from './creator/creator.command';
import { ImportCityCommand } from './import-city.command';
import { MigrateCommand } from './migrate.command';
import { ScreenshotCommand } from './screenshot/screenshot.command';

// Lists commands but also their other nest-commander DI dependencies.
export const commands: Provider[] = [
  // Root-level commands.
  ...ImportCityCommand.providers(),
  ...MigrateCommand.providers(),
  // Commands with sub-commands.
  ...CreatorCommand.providers(),
  ...ScreenshotCommand.providers()
];
