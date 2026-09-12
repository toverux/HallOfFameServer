import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import { createCreator, createScreenshot } from '../testing/factories';
import { FakeAiTranslatorService } from '../testing/fakes';
import { createServiceTestingModule } from '../testing/testing-module';
import { AiTranslatorService } from './ai-translator.service';
import { BackgroundTasksService } from './background-tasks.service';
import { CreatorService } from './creator.service';
import { PrismaService } from './prisma.service';
import { ScreenshotStatsService } from './screenshot-stats.service';
import { ViewService } from './view.service';

describe('ViewService', () => {
  let testingModule: TestingModule;

  let viewService: ViewService;

  let prisma: PrismaService;

  // A fresh module per test, as the views cache lives in the ViewService instance.
  beforeEach(async () => {
    testingModule = await createServiceTestingModule([
      ViewService,
      CreatorService,
      ScreenshotStatsService,
      BackgroundTasksService,
      { provide: AiTranslatorService, useValue: new FakeAiTranslatorService() }
    ]);

    viewService = testingModule.get(ViewService);
    prisma = testingModule.get(PrismaService);
  });

  afterEach(async () => {
    await testingModule.close();
  });

  // As the mod does, recording the view of a city while it asks for the next one. Over HTTP, the
  // order in which the two queries run is not under the test's control.
  test(`keeps a view recorded while the creator's views load`, async () => {
    const player = await createCreator(prisma);
    const screenshot = await createScreenshot(prisma, await createCreator(prisma));

    const loading = viewService.getViewedScreenshotIds(player.id);

    await viewService.markViewed(screenshot.id, player.id);

    expect(await loading).toEqual(new Set([screenshot.id]));
    expect(await viewService.getViewedScreenshotIds(player.id)).toEqual(new Set([screenshot.id]));
  });
});
