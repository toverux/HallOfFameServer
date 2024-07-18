import { AzureService } from './azure.service';
import { ConfigService } from './config.service';
import { CreatorService } from './creator.service';
import { PrismaService } from './prisma.service';
import { ScreenshotProcessingService } from './screenshot-processing.service';
import { ScreenshotUploaderService } from './screenshot-uploader.service';
import { ScreenshotService } from './screenshot.service';

export * from './azure.service';
export * from './config.service';
export * from './creator.service';
export * from './prisma.service';
export * from './screenshot.service';
export * from './screenshot-processing.service';
export * from './screenshot-uploader.service';

export const services = [
    AzureService,
    ConfigService,
    CreatorService,
    PrismaService,
    ScreenshotService,
    ScreenshotProcessingService,
    ScreenshotUploaderService
];
