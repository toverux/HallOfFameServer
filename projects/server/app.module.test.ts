import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { SchedulerRegistry } from '@nestjs/schedule';
import * as sentry from '@sentry/bun';
import { viewerBaseUrl } from './common/constants';
import { createCreator } from './testing/factories';
import { createTestApp, type TestApp } from './testing/test-app';

describe('AppModule', () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp.app.close();
  });

  test(`schedules no cron under test`, () => {
    expect(() => testApp.app.get(SchedulerRegistry)).toThrow();
  });

  test(`returns 404 for an unknown API route`, async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/api/v1/nothing-here' });

    expect(response.statusCode).toBe(404);

    expect(response.json<unknown>()).toEqual({
      statusCode: 404,
      message: 'Cannot GET /api/v1/nothing-here',
      error: 'Not Found'
    });
  });

  // Non-canonical paths, which the static file server refuses like a traversal attempt; the API one
  // matches no API route and falls through to it.
  test.each(['/admin//', '/api/v1//screenshots'])(
    `answers %s, a path the static file server refuses, with 403 without reporting it`,
    async url => {
      const captureException = spyOn(sentry, 'captureException');

      try {
        const response = await testApp.app.inject({ method: 'GET', url });

        expect(response.statusCode).toBe(403);
        expect(response.json<unknown>()).toEqual({ statusCode: 403, message: 'Forbidden' });
        expect(captureException).not.toHaveBeenCalled();
      } finally {
        captureException.mockRestore();
      }
    }
  );

  test(`allows cross-origin requests, as the viewer sends them from the browser`, async () => {
    const creator = await createCreator(testApp.prisma);

    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/v1/creators/${creator.id}`,
      headers: { origin: viewerBaseUrl }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });
});
