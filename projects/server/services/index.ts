import { ConfigService } from './config.service';
import { CreatorService } from './creator.service';
import { PrismaService } from './prisma.service';
import { ScreenshotProcessingService } from './screenshot-processing.service';

export * from './config.service';
export * from './creator.service';
export * from './prisma.service';
export * from './screenshot-processing.service';

export const services = [
    ConfigService,
    CreatorService,
    PrismaService,
    ScreenshotProcessingService
];
