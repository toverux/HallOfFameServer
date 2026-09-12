import type { ValueProvider } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Creator } from '#prisma-lib/client';
import { nn } from '../../shared/utils/type-assertion';
import { AppModule } from '../app.module';
import { configureApp } from '../configure-app';
import { createFastifyAdapter } from '../fastify';
import {
  AiTranslatorService,
  BackgroundTasksService,
  PrismaService,
  ScreenshotSimilarityDetectorService,
  ScreenshotStorageService
} from '../services';
import {
  FakeAiTranslatorService,
  FakeScreenshotSimilarityDetectorService,
  FakeScreenshotStorageService
} from './fakes';

export interface TestApp {
  /**
   * Send requests with `app.inject()`.
   */
  readonly app: NestFastifyApplication;
  readonly prisma: PrismaService;
  /**
   * Await `settled()` before asserting on the work a request left running.
   */
  readonly backgroundTasks: BackgroundTasksService;
  readonly screenshotStorage: FakeScreenshotStorageService;
  readonly aiTranslator: FakeAiTranslatorService;
  readonly screenshotSimilarityDetector: FakeScreenshotSimilarityDetectorService;
}

/**
 * Builds the app through the production bootstrap, with the default fakes in place of the external
 * services, and initializes it without listening.
 * `overrides` replace providers for one suite, the default fakes included.
 * Close the app after each test: services keep state in memory, the ban cache for one, and
 * closing waits for the background tasks, so none outlives its test.
 */
export async function createTestApp(overrides: readonly ValueProvider[] = []): Promise<TestApp> {
  const screenshotStorage = new FakeScreenshotStorageService();
  const aiTranslator = new FakeAiTranslatorService();
  const screenshotSimilarityDetector = new FakeScreenshotSimilarityDetectorService();

  const providers: readonly ValueProvider[] = [
    { provide: ScreenshotStorageService, useValue: screenshotStorage },
    { provide: AiTranslatorService, useValue: aiTranslator },
    { provide: ScreenshotSimilarityDetectorService, useValue: screenshotSimilarityDetector },
    // Last, so they win over the default fakes.
    ...overrides
  ];

  const builder = Test.createTestingModule({ imports: [AppModule] });

  for (const { provide, useValue } of providers) {
    builder.overrideProvider(provide).useValue(useValue);
  }

  const testingModule = await builder.compile();

  const app = testingModule.createNestApplication<NestFastifyApplication>(createFastifyAdapter());

  configureApp(app);

  await app.init();

  return {
    app,
    prisma: app.get(PrismaService),
    backgroundTasks: app.get(BackgroundTasksService),
    screenshotStorage,
    aiTranslator,
    screenshotSimilarityDetector
  };
}

/**
 * Headers of a request from the mod: the `Creator` Authorization header, from the Creator's most
 * recent hardware ID, sent from their most recent IP.
 * Without the forwarded IP, every `inject()` request comes from 127.0.0.1, which authentication
 * then records for every Creator, so distinct Creators would share an IP.
 */
export function modHeaders(
  creator: Pick<Creator, 'creatorName' | 'creatorId' | 'creatorIdProvider' | 'hwids' | 'ips'>
): Record<string, string> {
  return { 'authorization': modAuthorization(creator), 'x-forwarded-for': nn(creator.ips[0]) };
}

/**
 * Builds the `Creator` Authorization header the mod sends with every request.
 */
function modAuthorization(
  creator: Pick<Creator, 'creatorName' | 'creatorId' | 'creatorIdProvider' | 'hwids'>
): string {
  const params = [
    `name=${encodeURIComponent(creator.creatorName ?? '')}`,
    `id=${creator.creatorId}`,
    `provider=${creator.creatorIdProvider}`,
    `hwid=${nn(creator.hwids[0])}`
  ];

  return `Creator ${params.join('&')}`;
}
