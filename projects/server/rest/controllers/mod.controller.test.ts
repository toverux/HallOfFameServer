import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createMod } from '../../testing/factories';
import { createTestApp, type TestApp } from '../../testing/test-app';

describe('ModController', () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp.app.close();
  });

  describe('GET /api/v1/mods/:paradoxModId', () => {
    test(`redirects (307) to the mod's Paradox Mods page and counts the click`, async () => {
      const mod = await createMod(testApp.prisma, { paradoxModId: 74_604 });

      const response = await testApp.app.inject({ method: 'GET', url: '/api/v1/mods/74604' });

      expect(response.statusCode).toBe(307);
      expect(response.headers.location).toBe('https://mods.paradoxplaza.com/mods/74604/Windows');

      // No route serializes the click count.
      const after = await testApp.prisma.mod.findUniqueOrThrow({ where: { id: mod.id } });

      expect(after.clicks).toBe(1);
    });

    test(`returns 404 for a mod that was never cached`, async () => {
      const response = await testApp.app.inject({ method: 'GET', url: '/api/v1/mods/74604' });

      expect(response.statusCode).toBe(404);

      expect(response.json<unknown>()).toEqual({
        statusCode: 404,
        message: `Could not find resource with ID "74604".`,
        error: 'NotFoundByIdError'
      });
    });

    test(`returns 400 for an ID that is not a number`, async () => {
      const response = await testApp.app.inject({ method: 'GET', url: '/api/v1/mods/latest' });

      expect(response.statusCode).toBe(400);

      expect(response.json<unknown>()).toEqual({
        statusCode: 400,
        message: `Mod ID "latest" is not valid, expected an int.`,
        error: 'Bad Request'
      });
    });
  });
});
