import type { Provider } from '@nestjs/common';
import { AnniversaryCommand } from './anniversary.command';
import { CreatorCommand } from './creator/creator.command';
import { DigestCommand } from './digest.command';
import { ImportCityCommand } from './import-city.command';
import { MigrateCommand } from './migrate.command';
import { ModerateCommand } from './moderate/moderate.command';
import { ScreenshotCommand } from './screenshot/screenshot.command';

// Lists commands but also their other nest-commander DI dependencies.
export const commands: Provider[] = [
  // Root-level commands.
  ...AnniversaryCommand.providers(),
  ...DigestCommand.providers(),
  ...ImportCityCommand.providers(),
  ...MigrateCommand.providers(),
  // Commands with sub-commands.
  ...CreatorCommand.providers(),
  ...ModerateCommand.providers(),
  ...ScreenshotCommand.providers()
];
