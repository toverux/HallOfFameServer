import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { config } from '../../config';
import { createCreator, createScreenshot, createView } from '../../testing/factories';
import { createTestApp, modAuthorization, type TestApp } from '../../testing/test-app';

const paradoxModsLink = 'https://mods.paradoxplaza.com/authors/Mayor1';

describe('CreatorController', () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp.app.close();
  });

  describe('GET /api/v1/creators/:id', () => {
    test(`returns a creator by ObjectId, anonymously`, async () => {
      const creator = await createCreator(testApp.prisma, {
        socials: [{ platform: 'paradoxMods', link: paradoxModsLink, clicks: 3 }],
        viewerClicksCount: 5
      });

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/creators/${creator.id}`
      });

      expect(response.statusCode).toBe(200);

      expect(response.json<unknown>()).toEqual({
        id: creator.id,
        creatorName: 'Mayor 1',
        creatorNameSlug: 'mayor-1',
        creatorNameLocale: null,
        creatorNameLatinized: null,
        creatorNameTranslated: null,
        createdAt: creator.createdAt.toISOString(),
        viewerUrl: `${config.http.baseUrl}/api/v1/creators/${creator.id}/viewer`,
        viewerClicksCount: 5,
        socials: [
          {
            platform: 'paradoxMods',
            link: `${config.http.baseUrl}/api/v1/creators/${creator.id}/social/paradoxMods`,
            clicks: 3
          }
        ]
      });
    });

    test(`returns the authenticated creator for "me"`, async () => {
      const creator = await createCreator(testApp.prisma);

      await createCreator(testApp.prisma);

      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/me',
        headers: { authorization: `CreatorID ${creator.creatorId}` }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ id: string }>().id).toBe(creator.id);
    });

    test(`returns a creator by name, case-insensitively`, async () => {
      const creator = await createCreator(testApp.prisma, { creatorName: 'Mayor of Tokyo' });

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/creators/${encodeURIComponent('mAYOR OF tOKYO')}`
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ id: string }>().id).toBe(creator.id);
    });

    test(`returns a creator by name slug`, async () => {
      const creator = await createCreator(testApp.prisma, { creatorName: 'Mayor of Tokyo' });

      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/mayor-of-tokyo'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ id: string }>().id).toBe(creator.id);
    });

    test(`returns 404 for an unknown creator`, async () => {
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/nobody'
      });

      expect(response.statusCode).toBe(404);

      expect(response.json<unknown>()).toEqual({
        statusCode: 404,
        message: `Could not find resource with ID "nobody".`,
        error: 'NotFoundByIdError'
      });
    });
  });

  test.each([
    { method: 'GET', url: '/api/v1/creators/me' },
    // With a valid body, which is parsed before authentication is required.
    { method: 'PUT', url: '/api/v1/creators/me', payload: {} },
    { method: 'GET', url: '/api/v1/creators/me/stats' }
  ] as const)(`$method $url returns 401 without credentials`, async request => {
    const response = await testApp.app.inject(request);

    expect(response.statusCode).toBe(401);

    expect(response.json<unknown>()).toEqual({
      statusCode: 401,
      message: `Request not authenticated.`,
      error: 'UnauthorizedError'
    });
  });

  describe('PUT /api/v1/creators/me', () => {
    test(`updates the locale and merges the metadata the mod sends`, async () => {
      const creator = await createCreator(testApp.prisma, {
        locale: 'en-US',
        metadata: { modVersion: '2025.4.1', showViewCount: false, retiredSetting: true }
      });

      // The mod's payload, see HttpQueries.UpdateMe.cs in the mod repository.
      const metadata = {
        modVersion: '2026.0.0',
        isNvidiaGpu: true,
        screenWidth: 2560,
        screenHeight: 1440,
        useLegacyInterface: false,
        enableMainMenuSlideshow: true,
        enableLoadingScreenBackground: true,
        showFeaturedAsset: true,
        showCreatorSocials: true,
        showViewCount: true,
        namesTranslationMode: 'translate',
        popularScreenshotWeight: 10,
        trendingScreenshotWeight: 10,
        recentScreenshotWeight: 10,
        archeologistScreenshotWeight: 10,
        randomScreenshotWeight: 10,
        supporterScreenshotWeight: 10,
        viewMaxAge: 60,
        screenshotResolution: '4k',
        createLocalScreenshot: true,
        disableGlobalIllumination: false,
        paradoxModsBrowsingPreference: 'in-game'
      };

      const response = await testApp.app.inject({
        method: 'PUT',
        url: '/api/v1/creators/me',
        headers: { authorization: modAuthorization(creator) },
        payload: { locale: 'fr-FR', metadata }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ id: string }>().id).toBe(creator.id);

      // Neither field is serialized, so the database is the only place to see them.
      const updated = await testApp.prisma.creator.findUniqueOrThrow({
        where: { id: creator.id }
      });

      expect(updated.locale).toBe('fr-FR');
      expect(updated.metadata).toEqual({ ...metadata, retiredSetting: true });
    });
  });

  describe('GET /api/v1/creators/:id/stats', () => {
    test(`returns global counts and the counts of "me" or another creator`, async () => {
      const me = await createCreator(testApp.prisma);
      const other = await createCreator(testApp.prisma);

      const [mine] = await Promise.all([
        createScreenshot(testApp.prisma, me, {
          viewsCount: 10,
          uniqueViewsCount: 6,
          favoritesCount: 2
        }),
        createScreenshot(testApp.prisma, me, {
          viewsCount: 5,
          uniqueViewsCount: 4,
          favoritesCount: 1
        })
      ]);

      const theirs = await createScreenshot(testApp.prisma, other, {
        viewsCount: 7,
        uniqueViewsCount: 7,
        favoritesCount: 3
      });

      await Promise.all([
        createView(testApp.prisma, mine, other),
        createView(testApp.prisma, theirs, me),
        createView(testApp.prisma, theirs, me)
      ]);

      const myStats = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/me/stats',
        headers: { authorization: modAuthorization(me) }
      });

      expect(myStats.statusCode).toBe(200);

      expect(myStats.json<unknown>()).toEqual({
        allCreatorsCount: 2,
        allScreenshotsCount: 3,
        allViewsCount: 3,
        screenshotsCount: 2,
        viewsCount: 15,
        uniqueViewsCount: 10,
        favoritesCount: 3
      });

      // Anonymously, as the viewer asks.
      const otherStats = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/creators/${other.id}/stats`
      });

      expect(otherStats.statusCode).toBe(200);

      expect(otherStats.json<unknown>()).toEqual({
        allCreatorsCount: 2,
        allScreenshotsCount: 3,
        allViewsCount: 3,
        screenshotsCount: 1,
        viewsCount: 7,
        uniqueViewsCount: 7,
        favoritesCount: 3
      });
    });

    test(`returns zero counts for a creator without screenshots`, async () => {
      const creator = await createCreator(testApp.prisma);

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/creators/${creator.id}/stats`
      });

      expect(response.statusCode).toBe(200);

      expect(response.json<unknown>()).toEqual({
        allCreatorsCount: 1,
        allScreenshotsCount: 0,
        allViewsCount: 0,
        screenshotsCount: 0,
        viewsCount: 0,
        uniqueViewsCount: 0,
        favoritesCount: 0
      });
    });
  });

  describe('GET and HEAD /api/v1/creators/:id/social/:platform', () => {
    // HEAD is how the mod resolves a Paradox Mods username from the redirect.
    test.each(['GET', 'HEAD'] as const)(
      `%s redirects (307) to the stored link and counts the click`,
      async method => {
        const creator = await createCreator(testApp.prisma, {
          socials: [{ platform: 'paradoxMods', link: paradoxModsLink, clicks: 2 }]
        });

        const response = await testApp.app.inject({
          method,
          url: `/api/v1/creators/${creator.id}/social/paradoxMods`,
          headers: { authorization: modAuthorization(creator) }
        });

        expect(response.statusCode).toBe(307);
        expect(response.headers.location).toBe(paradoxModsLink);

        const after = await testApp.app.inject({
          method: 'GET',
          url: `/api/v1/creators/${creator.id}`
        });

        expect(after.json<{ socials: unknown }>().socials).toEqual([
          { platform: 'paradoxMods', link: expect.any(String), clicks: 3 }
        ]);
      }
    );

    test(`returns 404 for a platform the creator has no link for`, async () => {
      const creator = await createCreator(testApp.prisma, {
        socials: [{ platform: 'paradoxMods', link: paradoxModsLink, clicks: 0 }]
      });

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/creators/${creator.id}/social/youtube`
      });

      expect(response.statusCode).toBe(404);

      expect(response.json<unknown>()).toEqual({
        statusCode: 404,
        message: `Creator "Mayor 1" has no social link for "youtube".`,
        error: 'Not Found'
      });
    });
  });

  describe('GET /api/v1/creators/:id/viewer', () => {
    test(`redirects (307) to the creator's viewer page and counts the click`, async () => {
      const creator = await createCreator(testApp.prisma);

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/creators/${creator.id}/viewer`
      });

      expect(response.statusCode).toBe(307);

      expect(response.headers.location).toBe(
        `https://viewer.halloffame.mtq.io/?creator=${creator.id}`
      );

      const after = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/creators/${creator.id}`
      });

      expect(after.json<{ viewerClicksCount: unknown }>().viewerClicksCount).toBe(1);
    });
  });
});
