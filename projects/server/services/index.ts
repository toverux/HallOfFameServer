import { Provider } from '@nestjs/common';
import { AzureService } from './azure.service';
import { BanService } from './ban.service';
import { CreatorService } from './creator.service';
import { DateFnsLocalizationService } from './date-fns-localization.service';
import { PrismaService } from './prisma.service';
import { ScreenshotProcessingService } from './screenshot-processing.service';
import { ScreenshotStorageService } from './screenshot-storage.service';
import { ScreenshotService } from './screenshot.service';
import { ViewService } from './view.service';

export * from './azure.service';
export * from './ban.service';
export * from './creator.service';
export * from './date-fns-localization.service';
export * from './prisma.service';
export * from './screenshot.service';
export * from './screenshot-processing.service';
export * from './screenshot-storage.service';
export * from './view.service';

export const services: Provider[] = [
    AzureService,
    BanService,
    CreatorService,
    DateFnsLocalizationService,
    PrismaService,
    ScreenshotService,
    ScreenshotProcessingService,
    ScreenshotStorageService,
    ViewService
];
