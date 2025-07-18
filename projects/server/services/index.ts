import type { Provider } from '@nestjs/common';
import { AiTranslatorService } from './ai-translator.service';
import { AzureService } from './azure.service';
import { BanService } from './ban.service';
import { CitiesCollectiveService } from './cities-collective.service';
import { CreatorService } from './creator.service';
import { DateFnsLocalizationService } from './date-fns-localization.service';
import { FavoriteService } from './favorite.service';
import { PrismaService } from './prisma.service';
import { ScreenshotService } from './screenshot.service';
import { ScreenshotProcessingService } from './screenshot-processing.service';
import { ScreenshotSimilarityDetectorService } from './screenshot-similarity-detector.service';
import { ScreenshotStorageService } from './screenshot-storage.service';
import { ViewService } from './view.service';

export * from './ai-translator.service';
export * from './azure.service';
export * from './ban.service';
export * from './cities-collective.service';
export * from './creator.service';
export * from './date-fns-localization.service';
export * from './favorite.service';
export * from './prisma.service';
export * from './screenshot.service';
export * from './screenshot-processing.service';
export * from './screenshot-similarity-detector.service';
export * from './screenshot-storage.service';
export * from './view.service';

export const services: Provider[] = [
  AiTranslatorService,
  AzureService,
  BanService,
  CitiesCollectiveService,
  CreatorService,
  DateFnsLocalizationService,
  FavoriteService,
  PrismaService,
  ScreenshotService,
  ScreenshotProcessingService,
  ScreenshotSimilarityDetectorService,
  ScreenshotStorageService,
  ViewService
];
