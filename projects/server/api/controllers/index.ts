import { Type } from '@nestjs/common';
import { CreatorController } from './creator.controller';
import { ScreenshotController } from './screenshot.controller';

export * from './creator.controller';
export * from './screenshot.controller';

export const controllers: Type<unknown>[] = [
    CreatorController,
    ScreenshotController
];
