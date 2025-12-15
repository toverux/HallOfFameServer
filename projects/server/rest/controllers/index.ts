import type { Type } from '@nestjs/common';
import { CreatorController } from './creator.controller';
import { ModController } from './mod.controller';
import { ScreenshotController } from './screenshot.controller';
import { SystemController } from './system.controller';

export * from './creator.controller';
export * from './mod.controller';
export * from './screenshot.controller';
export * from './system.controller';

export const controllers: Type<unknown>[] = [
  CreatorController,
  ModController,
  ScreenshotController,
  SystemController
];
