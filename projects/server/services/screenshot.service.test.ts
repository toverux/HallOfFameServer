import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { nn } from '../../shared/utils/type-assertion';
import { createCreator, createScreenshot } from '../testing/factories';
import { createTestApp, type TestApp } from '../testing/test-app';
import { pickWeightedAlgorithm, ScreenshotService } from './screenshot.service';

describe('ScreenshotService.updateCityNameTranslation', () => {
  let testApp: TestApp;

  // The test app provides the service with its many dependencies, the fakes included.
  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp.app.close();
  });

  test(`leaves a screenshot renamed during its translation to the rename's own`, async () => {
    const screenshot = await createScreenshot(testApp.prisma, await createCreator(testApp.prisma), {
      cityName: '大阪',
      needsTranslation: true
    });

    // As the translation of the name before the rename finishes.
    const result = await testApp.app
      .get(ScreenshotService)
      .updateCityNameTranslation({ ...screenshot, cityName: '東京' });

    expect(result).toEqual({ translated: false });

    expect(
      await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: screenshot.id } })
    ).toEqual(screenshot);
  });
});

describe('pickWeightedAlgorithm', () => {
  test.each([
    { roll: 0, algorithm: 'random' },
    { roll: 0.24, algorithm: 'random' },
    { roll: 0.25, algorithm: 'popular' },
    { roll: 0.99, algorithm: 'popular' }
  ])(
    `picks $algorithm for a roll of $roll, proportionally to weight`,
    async ({ roll, algorithm }) => {
      const pick = await pickWeightedAlgorithm(
        { random: 1, popular: 3 },
        name => Promise.resolve(name),
        rolls(roll)
      );

      expect(pick).toEqual({ algorithm, result: algorithm });
    }
  );

  test(`never picks an algorithm weighted 0`, async () => {
    const pick = await pickWeightedAlgorithm(
      { random: 0, popular: 1, trending: 0 },
      name => Promise.resolve(name),
      rolls(0)
    );

    expect(pick).toEqual({ algorithm: 'popular', result: 'popular' });
  });

  test(`zeroes out an algorithm that returns nothing and picks again among the rest`, async () => {
    const tried: string[] = [];

    const results = { random: 'random', popular: null, trending: 'trending' };

    const pick = await pickWeightedAlgorithm(
      { random: 1, popular: 1, trending: 2 },
      name => {
        tried.push(name);

        return Promise.resolve(results[name]);
      },
      rolls(0.4, 0.3)
    );

    // 0.4 of 4 lands on popular; 0.3 of the 3 left lands on random, where 0.3 of 4 would not.
    expect(tried).toEqual(['popular', 'random']);
    expect(pick).toEqual({ algorithm: 'random', result: 'random' });
  });

  test(`gives up once every algorithm returned nothing`, async () => {
    const tried: string[] = [];

    const pick = await pickWeightedAlgorithm(
      { random: 1, popular: 1 },
      name => {
        tried.push(name);

        return Promise.resolve(null);
      },
      rolls(0, 0)
    );

    expect(pick).toBeUndefined();
    expect(tried).toEqual(['random', 'popular']);
  });

  test(`gives up without trying anything when every weight is 0`, async () => {
    const tried: string[] = [];

    const pick = await pickWeightedAlgorithm(
      { random: 0, popular: 0 },
      name => {
        tried.push(name);

        return Promise.resolve(name);
      },
      rolls()
    );

    expect(pick).toBeUndefined();
    expect(tried).toEqual([]);
  });
});

/**
 * A random source returning the given values in order, failing the test if it needs more.
 */
function rolls(...values: readonly number[]): () => number {
  const queue = [...values];

  return () => nn(queue.shift());
}
