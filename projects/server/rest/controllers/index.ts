import type { Type } from '@nestjs/common';
import { CreatorController } from './creator.controller';
import { DiscordController } from './discord.controller';
import { ModController } from './mod.controller';
import { ScreenshotController } from './screenshot.controller';
import { SystemController } from './system.controller';
import { UsageController } from './usage.controller';

export * from './creator.controller';
export * from './discord.controller';
export * from './mod.controller';
export * from './screenshot.controller';
export * from './system.controller';
export * from './usage.controller';

export const controllers: Array<Type<unknown>> = [
  CreatorController,
  DiscordController,
  ModController,
  ScreenshotController,
  SystemController,
  UsageController
];
