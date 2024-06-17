import { PrismaService } from './prisma.service';
import { ScreenshotProcessingService } from './screenshot-processing.service';

export * from './prisma.service';
export * from './screenshot-processing.service';

export const services = [PrismaService, ScreenshotProcessingService];
