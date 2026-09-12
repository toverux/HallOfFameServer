import { afterEach, describe, expect, test } from 'bun:test';
import { AiTranslatorService, ScreenshotStorageService } from '../services';
import { FakeAiTranslatorService } from './fakes';
import { createTestApp, type TestApp } from './test-app';

describe('createTestApp', () => {
  let testApp: TestApp;

  afterEach(async () => {
    await testApp.app.close();
  });

  test(`provides the default fakes`, async () => {
    testApp = await createTestApp();

    expect(testApp.app.get(AiTranslatorService)).toBe<unknown>(testApp.aiTranslator);
    expect(testApp.app.get(ScreenshotStorageService)).toBe<unknown>(testApp.screenshotStorage);
  });

  test(`lets a suite override replace a default fake, exposed in its place`, async () => {
    const aiTranslator = new FakeAiTranslatorService();

    testApp = await createTestApp([{ provide: AiTranslatorService, useValue: aiTranslator }]);

    expect(testApp.app.get(AiTranslatorService)).toBe<unknown>(aiTranslator);
    expect(testApp.aiTranslator).toBe(aiTranslator);
    expect(testApp.app.get(ScreenshotStorageService)).toBe<unknown>(testApp.screenshotStorage);
  });
});
