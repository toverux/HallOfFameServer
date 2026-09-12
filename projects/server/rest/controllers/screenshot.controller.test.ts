import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import {
  createCreator,
  createFavorite,
  createMod,
  createScreenshot,
  createView
} from '../../testing/factories';
import { fetchStub } from '../../testing/fetch-stub';
import {
  expectedFavoritePayload,
  expectedModPayload,
  expectedScreenshotPayload,
  expectedViewPayload
} from '../../testing/payloads';
import { createTestApp, modAuthorization, type TestApp } from '../../testing/test-app';

// An ObjectId no factory hands out.
const unknownScreenshotId = '0123456789abcdef01234567';

describe('ScreenshotController', () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp.app.close();
  });

  describe('GET /api/v1/screenshots', () => {
    test(`lists a creator's screenshots by ObjectId, anonymously`, async () => {
      const creator = await createCreator(testApp.prisma);
      const other = await createCreator(testApp.prisma);

      const first = await createScreenshot(testApp.prisma, creator);
      const second = await createScreenshot(testApp.prisma, creator);

      await createScreenshot(testApp.prisma, other);

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots?creatorId=${creator.id}`
      });

      expect(response.statusCode).toBe(200);

      expect(response.json<unknown>()).toEqual([
        expectedScreenshotPayload(first, creator, { __favorited: false }),
        expectedScreenshotPayload(second, creator, { __favorited: false })
      ]);
    });

    test(`lists a creator's screenshots by name, as the viewer's edge function asks`, async () => {
      const creator = await createCreator(testApp.prisma, { creatorName: 'Mayor of Tokyo' });
      const screenshot = await createScreenshot(testApp.prisma, creator);

      await createScreenshot(testApp.prisma, await createCreator(testApp.prisma));

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots?creatorId=${encodeURIComponent('Mayor of Tokyo')}`
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<Array<{ id: string }>>().map(({ id }) => id)).toEqual([screenshot.id]);
    });

    test(`returns 404 for an unknown creator name`, async () => {
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/screenshots?creatorId=nobody'
      });

      expect(response.statusCode).toBe(404);

      expect(response.json<unknown>()).toEqual({
        statusCode: 404,
        message: `Could not find resource with ID "nobody".`,
        error: 'NotFoundByIdError'
      });
    });

    test(`lists the authenticated creator's screenshots for "me"`, async () => {
      const creator = await createCreator(testApp.prisma);
      const screenshot = await createScreenshot(testApp.prisma, creator);

      await createScreenshot(testApp.prisma, await createCreator(testApp.prisma));

      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/screenshots?creatorId=me',
        headers: { authorization: modAuthorization(creator) }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<Array<{ id: string }>>().map(({ id }) => id)).toEqual([screenshot.id]);
    });

    test(`returns 401 for "me" without credentials`, async () => {
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/screenshots?creatorId=me'
      });

      expect(response.statusCode).toBe(401);

      expect(response.json<unknown>()).toEqual({
        statusCode: 401,
        message: `Request not authenticated.`,
        error: 'UnauthorizedError'
      });
    });

    test(`sets __favorited from the authenticated requester's likes`, async () => {
      const creator = await createCreator(testApp.prisma);
      const fan = await createCreator(testApp.prisma);

      const liked = await createScreenshot(testApp.prisma, creator);
      const notLiked = await createScreenshot(testApp.prisma, creator);

      await createFavorite(testApp.prisma, liked, fan);

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots?creatorId=${creator.id}`,
        headers: { authorization: modAuthorization(fan) }
      });

      expect(response.statusCode).toBe(200);

      expect(response.json<unknown>()).toEqual([
        expect.objectContaining({ id: liked.id, __favorited: true }),
        expect.objectContaining({ id: notLiked.id, __favorited: false })
      ]);
    });

    test(`includes favorites and views, as the viewer's trends ask`, async () => {
      const creator = await createCreator(testApp.prisma);
      const fan = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(testApp.prisma, creator);

      const favorite = await createFavorite(testApp.prisma, screenshot, fan);
      const view = await createView(testApp.prisma, screenshot, fan);

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots?creatorId=${creator.id}&favorites=true&views=true`
      });

      expect(response.statusCode).toBe(200);

      expect(response.json<unknown>()).toEqual([
        expectedScreenshotPayload(screenshot, creator, {
          favorites: [expectedFavoritePayload(favorite, fan)],
          views: [expectedViewPayload(view, fan)],
          __favorited: false
        })
      ]);
    });

    test(`returns 400 for favorites or views without a creator filter`, async () => {
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/screenshots?favorites=true'
      });

      expect(response.statusCode).toBe(400);

      expect(response.json<unknown>()).toEqual({
        statusCode: 400,
        message: `The 'favorites', 'views' and 'showcasedMods' include query parameters are only supported when filtering by creator ID.`,
        error: 'Bad Request'
      });
    });
  });

  describe('GET /api/v1/screenshots/:id', () => {
    test(`returns a screenshot anonymously, as the viewer's edge function asks`, async () => {
      const creator = await createCreator(testApp.prisma);
      const screenshot = await createScreenshot(testApp.prisma, creator);

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}`
      });

      expect(response.statusCode).toBe(200);

      expect(response.json<unknown>()).toEqual(
        expectedScreenshotPayload(screenshot, creator, { showcasedMod: null, __favorited: false })
      );
    });

    test(`includes favorites and views, as the viewer's city page asks`, async () => {
      const creator = await createCreator(testApp.prisma);
      const fan = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(testApp.prisma, creator);

      const favorite = await createFavorite(testApp.prisma, screenshot, fan);
      const view = await createView(testApp.prisma, screenshot, fan);

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}?favorites=true&views=true`
      });

      expect(response.statusCode).toBe(200);

      expect(response.json<unknown>()).toEqual(
        expectedScreenshotPayload(screenshot, creator, {
          showcasedMod: null,
          favorites: [expectedFavoritePayload(favorite, fan)],
          views: [expectedViewPayload(view, fan)],
          __favorited: false
        })
      );
    });

    test(`sets __favorited from the authenticated requester's likes`, async () => {
      const creator = await createCreator(testApp.prisma);
      const fan = await createCreator(testApp.prisma);
      const other = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(testApp.prisma, creator);

      await createFavorite(testApp.prisma, screenshot, fan);

      const asFan = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}`,
        headers: { authorization: modAuthorization(fan) }
      });

      expect(asFan.json<unknown>()).toEqual(expect.objectContaining({ __favorited: true }));

      const asOther = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}`,
        headers: { authorization: modAuthorization(other) }
      });

      expect(asOther.json<unknown>()).toEqual(expect.objectContaining({ __favorited: false }));
    });

    test(`includes the showcased mod`, async () => {
      const creator = await createCreator(testApp.prisma);
      const mod = await createMod(testApp.prisma);

      const screenshot = await createScreenshot(testApp.prisma, creator, {
        showcasedModId: mod.paradoxModId
      });

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}`
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ showcasedMod: unknown }>().showcasedMod).toEqual(
        expectedModPayload(mod)
      );
    });

    const modIds = [74_604, 87_755];

    const renderSettings = { aperture: 2.4 };

    test.each([
      {
        requester: 'the owner',
        shareParadoxModIds: false,
        shareRenderSettings: false,
        expected: { paradoxModIds: modIds, renderSettings }
      },
      {
        requester: 'another creator',
        shareParadoxModIds: false,
        shareRenderSettings: false,
        expected: { paradoxModIds: [], renderSettings: {} }
      },
      {
        requester: 'an anonymous visitor',
        shareParadoxModIds: false,
        shareRenderSettings: false,
        expected: { paradoxModIds: [], renderSettings: {} }
      },
      {
        requester: 'another creator',
        shareParadoxModIds: true,
        shareRenderSettings: false,
        expected: { paradoxModIds: modIds, renderSettings: {} }
      },
      {
        requester: 'an anonymous visitor',
        shareParadoxModIds: false,
        shareRenderSettings: true,
        expected: { paradoxModIds: [], renderSettings }
      }
    ] as const)(
      `shows $requester the mods and render settings the owner shared: $expected`,
      async ({ requester, shareParadoxModIds, shareRenderSettings, expected }) => {
        const creator = await createCreator(testApp.prisma);
        const other = await createCreator(testApp.prisma);

        const screenshot = await createScreenshot(testApp.prisma, creator, {
          shareParadoxModIds,
          paradoxModIds: modIds,
          shareRenderSettings,
          renderSettings
        });

        const headers = {
          'the owner': { authorization: modAuthorization(creator) },
          'another creator': { authorization: modAuthorization(other) },
          'an anonymous visitor': {}
        }[requester];

        const response = await testApp.app.inject({
          method: 'GET',
          url: `/api/v1/screenshots/${screenshot.id}`,
          headers
        });

        expect(response.statusCode).toBe(200);

        expect(response.json<unknown>()).toEqual(
          expect.objectContaining({ shareParadoxModIds, shareRenderSettings, ...expected })
        );
      }
    );

    describe('localized dates', () => {
      afterEach(() => {
        setSystemTime();
      });

      test.each([
        {
          name: 'en-US in UTC, without headers',
          headers: {},
          formatted: '01/15/2026, 10:00 AM',
          distance: '3 days ago'
        },
        {
          name: 'fr-FR at UTC+1',
          headers: { 'accept-language': 'fr-FR', 'x-timezone-offset': '60' },
          formatted: '15/01/2026, 11:00',
          distance: 'il y a 3 jours'
        },
        // The game sends script variants for Chinese.
        {
          name: 'zh-HANT at UTC-5',
          headers: { 'accept-language': 'zh-HANT', 'x-timezone-offset': '-300' },
          formatted: '26-01-15 上午 5:00',
          distance: '3 天前'
        },
        {
          name: 'zh-HANS at UTC+8',
          headers: { 'accept-language': 'zh-HANS', 'x-timezone-offset': '480' },
          formatted: '26-01-15 下午 6:00',
          distance: '3 天前'
        }
      ])(`formats dates for $name`, async ({ headers, formatted, distance }) => {
        const creator = await createCreator(testApp.prisma);

        const screenshot = await createScreenshot(testApp.prisma, creator, {
          createdAt: new Date('2026-01-15T10:00:00Z')
        });

        setSystemTime(new Date('2026-01-18T10:00:00Z'));

        const response = await testApp.app.inject({
          method: 'GET',
          url: `/api/v1/screenshots/${screenshot.id}`,
          headers
        });

        expect(response.statusCode).toBe(200);

        expect(response.json<unknown>()).toEqual(
          expect.objectContaining({
            createdAt: '2026-01-15T10:00:00.000Z',
            createdAtFormatted: formatted,
            createdAtFormattedDistance: distance
          })
        );
      });
    });
  });

  describe('GET /api/v1/screenshots/:id/viewer', () => {
    // Also proves the static route wins over /:id/:type.
    test(`redirects (307) to the screenshot's viewer page and counts the click`, async () => {
      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma)
      );

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}/viewer`
      });

      expect(response.statusCode).toBe(307);

      expect(response.headers.location).toBe(
        `https://viewer.halloffame.mtq.io/city/${screenshot.id}`
      );

      const after = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}`
      });

      expect(after.json<{ viewerClicksCount: unknown }>().viewerClicksCount).toBe(1);
    });
  });

  // Also proves the static route wins over /:id/:type.
  describe('GET /api/v1/screenshots/:id/playset', () => {
    test(`returns found mods, skips banned and missing ones, and caches all`, async () => {
      const cachedMod = await createMod(testApp.prisma, {
        paradoxModId: 74_604,
        subscribersCount: 1000
      });

      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma),
        { paradoxModIds: [74_604, 87_755, 90_001, 90_002] }
      );

      fetchStub.respondWithJson(paradoxModUrl(87_755), {
        modDetail: {
          modId: '87755',
          author: 'toverux',
          // Paradox Mods sends names and descriptions untrimmed, with Windows line endings.
          displayName: ' Hall of Fame\r\n',
          shortDescription: 'Share your cities.\r\nBrowse everyone else’s. ',
          displayImagePath: 'https://mods.paradoxplaza.com/thumbnails/hall-of-fame.jpg',
          tags: ['Code Mod'],
          subscriptions: 25_000,
          latestUpdate: '2026-08-30T14:00:00Z'
        }
      });

      fetchStub.respondWithJson(
        paradoxModUrl(90_001),
        { errorCode: 'bad-input', errorMessage: 'This mod version is banned' },
        { status: 400 }
      );

      fetchStub.respondWithJson(
        paradoxModUrl(90_002),
        {
          errorCode: 'bad-input',
          errorMessage: 'The mod with the specified modId could not be found'
        },
        { status: 400 }
      );

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}/playset`
      });

      expect(response.statusCode).toBe(200);

      // Most subscribed first.
      expect(response.json<unknown>()).toEqual([
        {
          id: expect.any(String),
          paradoxModId: 87_755,
          name: 'Hall of Fame',
          authorName: 'toverux',
          shortDescription: 'Share your cities.\nBrowse everyone else’s.',
          thumbnailUrl: 'https://mods.paradoxplaza.com/thumbnails/hall-of-fame.jpg',
          tags: ['Code Mod'],
          subscribersCount: 25_000,
          knownLastUpdatedAt: '2026-08-30T14:00:00.000Z'
        },
        expectedModPayload(cachedMod)
      ]);

      expect(fetchStub.requests.toSorted()).toEqual([
        paradoxModUrl(87_755),
        paradoxModUrl(90_001),
        paradoxModUrl(90_002)
      ]);

      const again = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}/playset`
      });

      expect(again.json<unknown>()).toEqual(response.json<unknown>());
      expect(fetchStub.requests).toHaveLength(3);
    });

    test(`returns 403 when the creator did not share their playset`, async () => {
      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma),
        { shareParadoxModIds: false, paradoxModIds: [74_604] }
      );

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}/playset`
      });

      expect(response.statusCode).toBe(403);

      expect(response.json<unknown>()).toEqual({
        statusCode: 403,
        message: `The creator has decided not to share their playset for this screenshot.`,
        error: 'PlaysetNotSharedError'
      });
    });
  });

  describe('GET /api/v1/screenshots/weighted', () => {
    test(`is not captured by /:id`, async () => {
      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma)
      );

      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/screenshots/weighted'
      });

      expect(response.statusCode).toBe(200);

      expect(response.json<unknown>()).toEqual(
        expect.objectContaining({ id: screenshot.id, __algorithm: 'random_default' })
      );
    });
  });

  test.each(['', '/viewer', '/playset'])(
    `GET /api/v1/screenshots/:id%s returns 404 for an unknown screenshot`,
    async path => {
      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${unknownScreenshotId}${path}`
      });

      expect(response.statusCode).toBe(404);

      expect(response.json<unknown>()).toEqual({
        statusCode: 404,
        message: `Could not find resource with ID "${unknownScreenshotId}".`,
        error: 'NotFoundByIdError'
      });
    }
  );
});

function paradoxModUrl(modId: number): string {
  return `https://api.paradox-interactive.com/mods?modId=${modId}&os=Windows`;
}
