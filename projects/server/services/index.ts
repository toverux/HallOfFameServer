import { Provider } from '@nestjs/common';
import { AzureService } from './azure.service';
import { BanService } from './ban.service';
import { CreatorService } from './creator.service';
import { PrismaService } from './prisma.service';
import { ScreenshotProcessingService } from './screenshot-processing.service';
import { ScreenshotUploaderService } from './screenshot-uploader.service';
import { ScreenshotService } from './screenshot.service';
import { ViewService } from './view.service';

export * from './azure.service';
export * from './ban.service';
export * from './creator.service';
export * from './prisma.service';
export * from './screenshot.service';
export * from './screenshot-processing.service';
export * from './screenshot-uploader.service';
export * from './view.service';

export const services: Provider[] = [
    AzureService,
    BanService,
    CreatorService,
    PrismaService,
    ScreenshotService,
    ScreenshotProcessingService,
    ScreenshotUploaderService,
    ViewService
];
