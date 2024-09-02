import { Type } from '@nestjs/common';
import { ScreenshotController } from './screenshot.controller';

export * from './screenshot.controller';

export const controllers: Type<unknown>[] = [ScreenshotController];
