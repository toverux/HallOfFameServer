import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as dfns from 'date-fns';
import type { Creator, Screenshot } from '#prisma-lib/client';
import { nn } from '../../../shared/utils/type-assertion';
import { config } from '../../config';
import type { PrismaService } from '../../services';
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
import { createTestApp, modHeaders, type TestApp } from '../../testing/test-app';

// An ObjectId no factory hands out.
const unknownScreenshotId = '0123456789abcdef01234567';

/**
 * Builds a requester's account relative to a fan who liked a screenshot.
 * Every account but the unrelated one shares the fan's like: multi-accounting on likes is not
 * allowed.
 */
const accounts = {
  'the fan': (_prisma, fan) => Promise.resolve(fan),
  'another account on the same hardware ID': (prisma, fan) =>
    createCreator(prisma, { hwids: [nn(fan.hwids[0])] }),
  'another account on the same IP': (prisma, fan) =>
    createCreator(prisma, { ips: [nn(fan.ips[0])] }),
  'an unrelated account': prisma => createCreator(prisma)
} satisfies Record<string, (prisma: PrismaService, fan: Creator) => Promise<Creator>>;

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
        headers: modHeaders(creator)
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
        headers: modHeaders(fan)
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
        headers: modHeaders(fan)
      });

      expect(asFan.json<unknown>()).toEqual(expect.objectContaining({ __favorited: true }));

      const asOther = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}`,
        headers: modHeaders(other)
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
          'the owner': modHeaders(creator),
          'another creator': modHeaders(other),
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

    test(`serves anonymous requests, as the viewer sends them`, async () => {
      const creator = await createCreator(testApp.prisma);
      const screenshot = await createScreenshot(testApp.prisma, creator);

      await createView(testApp.prisma, screenshot, await createCreator(testApp.prisma));

      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/screenshots/weighted?random=1&viewMaxAge=60'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<unknown>()).toEqual(weightedPayload(screenshot, creator, 'random'));
    });

    // Each algorithm weighted alone, against a screenshot it selects and ones it passes over.
    describe('algorithms', () => {
      const { popularScreenshotsMinFavorites: minFavorites, recencyThresholdDays } =
        config.screenshots;

      test(`random: a screenshot that is not reported`, async () => {
        const creator = await createCreator(testApp.prisma);
        const screenshot = await createScreenshot(testApp.prisma, creator);

        await createScreenshot(testApp.prisma, creator, { isReported: true });

        const response = await testApp.app.inject({
          method: 'GET',
          url: '/api/v1/screenshots/weighted?random=1'
        });

        expect(response.statusCode).toBe(200);
        expect(response.json<unknown>()).toEqual(weightedPayload(screenshot, creator, 'random'));
      });

      test(`popular: a screenshot with enough likes`, async () => {
        const creator = await createCreator(testApp.prisma);

        const screenshot = await createScreenshot(testApp.prisma, creator, {
          favoritesCount: minFavorites,
          favoritingPercentage: 50
        });

        await createScreenshot(testApp.prisma, creator, {
          favoritesCount: minFavorites - 1,
          favoritingPercentage: 80
        });

        const response = await testApp.app.inject({
          method: 'GET',
          url: '/api/v1/screenshots/weighted?popular=1'
        });

        expect(response.statusCode).toBe(200);
        expect(response.json<unknown>()).toEqual(weightedPayload(screenshot, creator, 'popular'));
      });

      test(`popular: passes over a favoriting percentage under the startup threshold`, async () => {
        const creator = await createCreator(testApp.prisma);

        const screenshot = await createScreenshot(testApp.prisma, creator, {
          favoritesCount: minFavorites,
          favoritingPercentage: 10
        });

        // Reported, so popular cannot select them, but they raise the threshold.
        for (let i = 0; i < 2; i++) {
          // oxlint-disable-next-line no-await-in-loop - sequential factory numbering
          await createScreenshot(testApp.prisma, creator, {
            favoritesCount: minFavorites,
            favoritingPercentage: 90,
            isReported: true
          });
        }

        // The threshold is computed when the app starts.
        await testApp.app.close();

        testApp = await createTestApp();

        const response = await testApp.app.inject({
          method: 'GET',
          url: '/api/v1/screenshots/weighted?popular=1'
        });

        expect(response.statusCode).toBe(200);

        expect(response.json<unknown>()).toEqual(
          expect.objectContaining({ id: screenshot.id, __algorithm: 'random_default' })
        );
      });

      test(`trending: a favoriting percentage above 1%`, async () => {
        const creator = await createCreator(testApp.prisma);

        const screenshot = await createScreenshot(testApp.prisma, creator, {
          favoritingPercentage: 2
        });

        await createScreenshot(testApp.prisma, creator, { favoritingPercentage: 1 });

        const response = await testApp.app.inject({
          method: 'GET',
          url: '/api/v1/screenshots/weighted?trending=1'
        });

        expect(response.statusCode).toBe(200);
        expect(response.json<unknown>()).toEqual(weightedPayload(screenshot, creator, 'trending'));
      });

      test(`recent: a screenshot younger than the recency threshold`, async () => {
        const creator = await createCreator(testApp.prisma);

        const screenshot = await createScreenshot(testApp.prisma, creator, {
          createdAt: dfns.subDays(new Date(), recencyThresholdDays - 1)
        });

        await createScreenshot(testApp.prisma, creator, {
          createdAt: dfns.subDays(new Date(), recencyThresholdDays + 1)
        });

        const response = await testApp.app.inject({
          method: 'GET',
          url: '/api/v1/screenshots/weighted?recent=1'
        });

        expect(response.statusCode).toBe(200);
        expect(response.json<unknown>()).toEqual(weightedPayload(screenshot, creator, 'recent'));
      });

      test(`archeologist: a screenshot older than the recency threshold`, async () => {
        const creator = await createCreator(testApp.prisma);

        const screenshot = await createScreenshot(testApp.prisma, creator, {
          createdAt: dfns.subDays(new Date(), recencyThresholdDays + 1)
        });

        await createScreenshot(testApp.prisma, creator, {
          createdAt: dfns.subDays(new Date(), recencyThresholdDays - 1)
        });

        const response = await testApp.app.inject({
          method: 'GET',
          url: '/api/v1/screenshots/weighted?archeologist=1'
        });

        expect(response.statusCode).toBe(200);

        expect(response.json<unknown>()).toEqual(
          weightedPayload(screenshot, creator, 'archeologist')
        );
      });

      test(`supporter: a supporter's least viewed screenshot`, async () => {
        const supporter = await createCreator(testApp.prisma, { isSupporter: true });

        const screenshot = await createScreenshot(testApp.prisma, supporter, { viewsCount: 1 });

        await createScreenshot(testApp.prisma, supporter, { viewsCount: 2 });

        await createScreenshot(testApp.prisma, await createCreator(testApp.prisma), {
          viewsCount: 0
        });

        const response = await testApp.app.inject({
          method: 'GET',
          url: '/api/v1/screenshots/weighted?supporter=1'
        });

        expect(response.statusCode).toBe(200);

        expect(response.json<unknown>()).toEqual(
          weightedPayload(screenshot, supporter, 'supporter')
        );
      });
    });

    describe('recently viewed screenshots', () => {
      test(`skips a screenshot the requester viewed within viewMaxAge`, async () => {
        const creator = await createCreator(testApp.prisma);
        const player = await createCreator(testApp.prisma);

        const viewed = await createScreenshot(testApp.prisma, creator);
        const unseen = await createScreenshot(testApp.prisma, creator);

        await createView(testApp.prisma, viewed, player, {
          viewedAt: dfns.subDays(new Date(), 29)
        });

        const response = await testApp.app.inject({
          method: 'GET',
          url: '/api/v1/screenshots/weighted?random=1&viewMaxAge=30',
          headers: modHeaders(player)
        });

        expect(response.statusCode).toBe(200);
        expect(response.json<unknown>()).toEqual(weightedPayload(unseen, creator, 'random'));
      });

      // As after a restart, or once the requester's views were evicted from the cache.
      test(`still skips earlier views when a view is posted before asking`, async () => {
        const creator = await createCreator(testApp.prisma);
        const player = await createCreator(testApp.prisma);

        const seenEarlier = await createScreenshot(testApp.prisma, creator);
        const current = await createScreenshot(testApp.prisma, creator);

        await createView(testApp.prisma, seenEarlier, player, {
          viewedAt: dfns.subDays(new Date(), 1)
        });

        const view = await testApp.app.inject({
          method: 'POST',
          url: `/api/v1/screenshots/${current.id}/views`,
          headers: modHeaders(player)
        });

        expect(view.statusCode).toBe(201);

        const response = await testApp.app.inject({
          method: 'GET',
          url: '/api/v1/screenshots/weighted?random=1&viewMaxAge=60',
          headers: modHeaders(player)
        });

        expect(response.statusCode).toBe(200);

        // Both seen, so only the fallback serves one.
        expect(response.json<unknown>()).toEqual(
          expect.objectContaining({ __algorithm: 'random_default' })
        );
      });

      test(`applies a viewMaxAge set after asking without a limit`, async () => {
        const player = await createCreator(testApp.prisma);

        const screenshot = await createScreenshot(
          testApp.prisma,
          await createCreator(testApp.prisma)
        );

        await createView(testApp.prisma, screenshot, player, {
          viewedAt: dfns.subDays(new Date(), 90)
        });

        const unlimited = await testApp.app.inject({
          method: 'GET',
          url: '/api/v1/screenshots/weighted?random=1&viewMaxAge=0',
          headers: modHeaders(player)
        });

        expect(unlimited.json<unknown>()).toEqual(
          expect.objectContaining({ id: screenshot.id, __algorithm: 'random_default' })
        );

        const limited = await testApp.app.inject({
          method: 'GET',
          url: '/api/v1/screenshots/weighted?random=1&viewMaxAge=60',
          headers: modHeaders(player)
        });

        expect(limited.json<unknown>()).toEqual(
          expect.objectContaining({ id: screenshot.id, __algorithm: 'random' })
        );
      });

      // Alone in the database, the screenshot comes from random when eligible, and from the
      // fallback when random skipped it.
      test.each([
        { query: 'viewMaxAge=30', viewedDaysAgo: 29, algorithm: 'random_default' },
        { query: 'viewMaxAge=30', viewedDaysAgo: 31, algorithm: 'random' },
        // The viewMaxAge parameter defaults to 60 days.
        { query: '', viewedDaysAgo: 59, algorithm: 'random_default' },
        { query: '', viewedDaysAgo: 61, algorithm: 'random' },
        // 0 means views never expire.
        { query: 'viewMaxAge=0', viewedDaysAgo: 3650, algorithm: 'random_default' }
      ])(
        `serves a screenshot viewed $viewedDaysAgo days ago through $algorithm for "$query"`,
        async ({ query, viewedDaysAgo, algorithm }) => {
          const player = await createCreator(testApp.prisma);

          const screenshot = await createScreenshot(
            testApp.prisma,
            await createCreator(testApp.prisma)
          );

          await createView(testApp.prisma, screenshot, player, {
            viewedAt: dfns.subDays(new Date(), viewedDaysAgo)
          });

          const response = await testApp.app.inject({
            method: 'GET',
            url: `/api/v1/screenshots/weighted?random=1&${query}`,
            headers: modHeaders(player)
          });

          expect(response.statusCode).toBe(200);

          expect(response.json<unknown>()).toEqual(
            expect.objectContaining({ id: screenshot.id, __algorithm: algorithm })
          );
        }
      );
    });
  });

  describe('POST /api/v1/screenshots/:id/views', () => {
    test(`records a view by the authenticated creator and counts it`, async () => {
      const player = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma)
      );

      const response = await testApp.app.inject({
        method: 'POST',
        url: `/api/v1/screenshots/${screenshot.id}/views`,
        headers: modHeaders(player)
      });

      expect(response.statusCode).toBe(201);

      const view = await testApp.prisma.view.findFirstOrThrow();

      expect(view).toMatchObject({ screenshotId: screenshot.id, creatorId: player.id });
      expect(response.json<unknown>()).toEqual(expectedViewPayload(view));

      expect(
        await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: screenshot.id } })
      ).toMatchObject({ viewsCount: 1 });
    });
  });

  describe('POST /api/v1/screenshots/:id/favorites', () => {
    test(`likes the screenshot from the creator's IP and hardware ID, and counts it`, async () => {
      const fan = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma)
      );

      const response = await testApp.app.inject({
        method: 'POST',
        url: `/api/v1/screenshots/${screenshot.id}/favorites`,
        headers: modHeaders(fan)
      });

      expect(response.statusCode).toBe(201);

      const favorite = await testApp.prisma.favorite.findFirstOrThrow();

      expect(favorite).toMatchObject({
        screenshotId: screenshot.id,
        creatorId: fan.id,
        ip: nn(fan.ips[0]),
        hwid: nn(fan.hwids[0])
      });

      expect(response.json<unknown>()).toEqual(expectedFavoritePayload(favorite));

      expect(
        await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: screenshot.id } })
      ).toMatchObject({ favoritesCount: 1 });
    });

    test.each([
      'the fan',
      'another account on the same hardware ID',
      'another account on the same IP'
    ] as const)(`rejects a second like from %s`, async account => {
      const fan = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma)
      );

      const like = await testApp.app.inject({
        method: 'POST',
        url: `/api/v1/screenshots/${screenshot.id}/favorites`,
        headers: modHeaders(fan)
      });

      expect(like.statusCode).toBe(201);

      const response = await testApp.app.inject({
        method: 'POST',
        url: `/api/v1/screenshots/${screenshot.id}/favorites`,
        headers: modHeaders(await accounts[account](testApp.prisma, fan))
      });

      expect(response.statusCode).toBe(400);

      expect(response.json<unknown>()).toEqual({
        statusCode: 400,
        message: `You have already favorited this screenshot.`,
        error: 'AlreadyInFavoritesError'
      });

      expect(await testApp.prisma.favorite.count()).toBe(1);

      expect(
        await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: screenshot.id } })
      ).toMatchObject({ favoritesCount: 1 });
    });

    test(`counts likes from unrelated accounts separately`, async () => {
      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma)
      );

      for (const fan of [
        await createCreator(testApp.prisma),
        await createCreator(testApp.prisma)
      ]) {
        // oxlint-disable-next-line no-await-in-loop - one like after the other, as players do
        const response = await testApp.app.inject({
          method: 'POST',
          url: `/api/v1/screenshots/${screenshot.id}/favorites`,
          headers: modHeaders(fan)
        });

        expect(response.statusCode).toBe(201);
      }

      expect(await testApp.prisma.favorite.count()).toBe(2);
    });
  });

  describe('DELETE /api/v1/screenshots/:id/favorites/mine', () => {
    test(`unlikes the screenshot`, async () => {
      const fan = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma)
      );

      const favorite = await createFavorite(testApp.prisma, screenshot, fan);

      const response = await testApp.app.inject({
        method: 'DELETE',
        url: `/api/v1/screenshots/${screenshot.id}/favorites/mine`,
        headers: modHeaders(fan)
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<unknown>()).toEqual(expectedFavoritePayload(favorite));
      expect(await testApp.prisma.favorite.count()).toBe(0);
    });

    test(`returns 400 when the screenshot is not liked`, async () => {
      const player = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma)
      );

      const response = await testApp.app.inject({
        method: 'DELETE',
        url: `/api/v1/screenshots/${screenshot.id}/favorites/mine`,
        headers: modHeaders(player)
      });

      expect(response.statusCode).toBe(400);

      expect(response.json<unknown>()).toEqual({
        statusCode: 400,
        message: `You have not favorited this screenshot.`,
        error: 'NotInFavoritesError'
      });
    });
  });

  describe('POST /api/v1/screenshots/:id/reports', () => {
    test(`marks the screenshot reported by the authenticated creator`, async () => {
      const creator = await createCreator(testApp.prisma);
      const player = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(testApp.prisma, creator);

      const response = await testApp.app.inject({
        method: 'POST',
        url: `/api/v1/screenshots/${screenshot.id}/reports`,
        headers: modHeaders(player)
      });

      expect(response.statusCode).toBe(201);

      const reported = await testApp.prisma.screenshot.findUniqueOrThrow({
        where: { id: screenshot.id }
      });

      expect(reported).toMatchObject({ isReported: true, reportedById: player.id });
      expect(response.json<unknown>()).toEqual(expectedScreenshotPayload(reported, creator));
    });

    test(`returns 403 for a screenshot an administrator approved`, async () => {
      const creator = await createCreator(testApp.prisma);
      const player = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(testApp.prisma, creator, { isApproved: true });

      const response = await testApp.app.inject({
        method: 'POST',
        url: `/api/v1/screenshots/${screenshot.id}/reports`,
        headers: modHeaders(player)
      });

      expect(response.statusCode).toBe(403);

      expect(response.json<unknown>()).toEqual({
        statusCode: 403,
        message:
          `Screenshot "${screenshot.cityName}" by ${creator.creatorName} has already been ` +
          `approved manually by an administrator, and hence can't be reported. ` +
          `If you think this is a mistake, please contact support (${config.supportContact}).`,
        error: 'ScreenshotApprovedError'
      });

      expect(
        await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: screenshot.id } })
      ).toMatchObject({ isReported: false });
    });
  });

  // The mod reads __favorited from the weighted route, the viewer from the others.
  test.each([
    { account: 'the fan', favorited: true },
    { account: 'another account on the same hardware ID', favorited: true },
    { account: 'another account on the same IP', favorited: true },
    { account: 'an unrelated account', favorited: false }
  ] as const)(
    `__favorited is $favorited on every screenshot route for $account`,
    async ({ account, favorited }) => {
      const creator = await createCreator(testApp.prisma);
      const fan = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(testApp.prisma, creator);

      await createFavorite(testApp.prisma, screenshot, fan);

      const headers = modHeaders(await accounts[account](testApp.prisma, fan));

      const single = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}`,
        headers
      });

      const list = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots?creatorId=${creator.id}`,
        headers
      });

      const weighted = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/screenshots/weighted?random=1',
        headers
      });

      expect(single.json<unknown>()).toEqual(expect.objectContaining({ __favorited: favorited }));
      expect(list.json<unknown>()).toEqual([expect.objectContaining({ __favorited: favorited })]);

      expect(weighted.json<unknown>()).toEqual(
        expect.objectContaining({ id: screenshot.id, __favorited: favorited })
      );
    }
  );

  test(`main-menu slideshow loop: serves every city once, then the ones not reported`, async () => {
    const creator = await createCreator(testApp.prisma);
    const player = await createCreator(testApp.prisma);

    for (let i = 0; i < 3; i++) {
      // oxlint-disable-next-line no-await-in-loop - sequential factory numbering
      await createScreenshot(testApp.prisma, creator);
    }

    const first = await nextScreenshot();

    expect(first).toMatchObject({ __algorithm: 'random', __favorited: false });
    expect(await send('POST', `${first.id}/views`)).toBe(201);
    expect(await send('POST', `${first.id}/favorites`)).toBe(201);

    const second = await nextScreenshot();

    expect(second).toMatchObject({ __algorithm: 'random', __favorited: false });
    expect(second.id).not.toBe(first.id);
    expect(await send('POST', `${second.id}/views`)).toBe(201);
    expect(await send('POST', `${second.id}/reports`)).toBe(201);

    const third = await nextScreenshot();

    expect(third).toMatchObject({ __algorithm: 'random', __favorited: false });
    expect([first.id, second.id]).not.toContain(third.id);
    expect(await send('POST', `${third.id}/views`)).toBe(201);
    expect(await send('POST', `${third.id}/favorites`)).toBe(201);
    expect(await send('DELETE', `${third.id}/favorites/mine`)).toBe(200);

    // Every city seen: the fallback serves one the player saw, never the reported one.
    const fallback = await nextScreenshot();

    expect([first.id, third.id]).toContain(fallback.id);

    expect(fallback).toMatchObject({
      __algorithm: 'random_default',
      __favorited: fallback.id == first.id
    });

    expect(await testApp.prisma.view.count()).toBe(3);

    expect(await testApp.prisma.favorite.findMany()).toMatchObject([
      { screenshotId: first.id, creatorId: player.id }
    ]);

    async function nextScreenshot(): Promise<{
      id: string;
      __algorithm: string;
      __favorited: boolean;
    }> {
      const response = await testApp.app.inject({
        method: 'GET',
        // As the mod asks, with only random weighted so any screenshot left is eligible.
        url:
          '/api/v1/screenshots/weighted' +
          '?random=1&popular=0&trending=0&recent=0&archeologist=0&supporter=0&viewMaxAge=60',
        headers: modHeaders(player)
      });

      expect(response.statusCode).toBe(200);

      return response.json<{ id: string; __algorithm: string; __favorited: boolean }>();
    }

    async function send(method: 'POST' | 'DELETE', path: string): Promise<number> {
      const response = await testApp.app.inject({
        method,
        url: `/api/v1/screenshots/${path}`,
        headers: modHeaders(player)
      });

      return response.statusCode;
    }
  });

  test.each([
    { method: 'POST', path: '/views' },
    { method: 'POST', path: '/favorites' },
    { method: 'DELETE', path: '/favorites/mine' },
    { method: 'POST', path: '/reports' }
  ] as const)(
    `$method /api/v1/screenshots/:id$path returns 401 without credentials`,
    async ({ method, path }) => {
      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma)
      );

      const response = await testApp.app.inject({
        method,
        url: `/api/v1/screenshots/${screenshot.id}${path}`
      });

      expect(response.statusCode).toBe(401);

      expect(response.json<unknown>()).toEqual({
        statusCode: 401,
        message: `Request not authenticated.`,
        error: 'UnauthorizedError'
      });

      expect(
        await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: screenshot.id } })
      ).toEqual(screenshot);

      expect(await testApp.prisma.view.count()).toBe(0);
      expect(await testApp.prisma.favorite.count()).toBe(0);
    }
  );

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

/**
 * The Screenshot as the weighted route serves it to a requester who has not liked it.
 */
function weightedPayload(
  screenshot: Screenshot,
  creator: Creator,
  algorithm: string
): Record<string, unknown> {
  return expectedScreenshotPayload(screenshot, creator, {
    showcasedMod: null,
    __algorithm: algorithm,
    __favorited: false
  });
}

function paradoxModUrl(modId: number): string {
  return `https://api.paradox-interactive.com/mods?modId=${modId}&os=Windows`;
}
