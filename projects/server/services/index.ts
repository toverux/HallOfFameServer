import type { Provider } from '@nestjs/common';
import { AiTranslatorService } from './ai-translator.service';
import { AzureService } from './azure.service';
import { BanService } from './ban.service';
import { CreatorService } from './creator.service';
import { CreatorAuthenticationService } from './creator-authentication.service';
import { DateFnsLocalizationService } from './date-fns-localization.service';
import { FavoriteService } from './favorite.service';
import { ModService } from './mod.service';
import { PrismaService } from './prisma.service';
import { ScreenshotService } from './screenshot.service';
import { ScreenshotMergingService } from './screenshot-merging.service';
import { ScreenshotProcessingService } from './screenshot-processing.service';
import { ScreenshotSimilarityDetectorService } from './screenshot-similarity-detector.service';
import { ScreenshotStatsService } from './screenshot-stats.service';
import { ScreenshotStorageService } from './screenshot-storage.service';
import { ViewService } from './view.service';

export * from './ai-translator.service';
export * from './azure.service';
export * from './ban.service';
export * from './creator.service';
export * from './creator-authentication.service';
export * from './date-fns-localization.service';
export * from './favorite.service';
export * from './mod.service';
export * from './prisma.service';
export * from './screenshot.service';
export * from './screenshot-merging.service';
export * from './screenshot-processing.service';
export * from './screenshot-similarity-detector.service';
export * from './screenshot-stats.service';
export * from './screenshot-storage.service';
export * from './view.service';

export const services: Provider[] = [
  AiTranslatorService,
  AzureService,
  BanService,
  CreatorService,
  CreatorAuthenticationService,
  DateFnsLocalizationService,
  FavoriteService,
  ModService,
  PrismaService,
  ScreenshotService,
  ScreenshotMergingService,
  ScreenshotProcessingService,
  ScreenshotSimilarityDetectorService,
  ScreenshotStatsService,
  ScreenshotStorageService,
  ViewService
];
