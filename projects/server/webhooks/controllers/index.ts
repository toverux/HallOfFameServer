import type { Type } from '@nestjs/common';
import { CitiesCollectiveController } from './cities-collective.controller';

export * from './cities-collective.controller';

export const controllers: Type<unknown>[] = [CitiesCollectiveController];
