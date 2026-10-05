import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import * as sentry from '@sentry/bun';
import * as Bun from 'bun';
import * as dfns from 'date-fns';
import sharp from 'sharp';
import type { Creator, Screenshot } from '#prisma-lib/client';
import { allFulfilled } from '../../../shared/utils/all-fulfilled';
import type { JsonObject, JsonValue } from '../../../shared/utils/json';
import { nn } from '../../../shared/utils/type-assertion';
import { config } from '../../config';
import type { PrismaService } from '../../services';
import {
  createBan,
  createCreator,
  createFavorite,
  createMod,
  createScreenshot,
  createView
} from '../../testing/factories';
import { fetchStub } from '../../testing/fetch-stub';
import * as identifiers from '../../testing/identifiers';
import {
  expectedFavoritePayload,
  expectedModPayload,
  expectedScreenshotPayload,
  expectedViewPayload
} from '../../testing/payloads';
import { createTestApp, modHeaders, type TestApp } from '../../testing/test-app';
import {
  validateCityName,
  validateDescription,
  validateMetadata,
  validateMilestone,
  validateModIds,
  validatePopulation,
  validateRenderConditions,
  validateRenderSettings
} from './screenshot.controller';

/**
 * Builds a requester's account relative to the one that liked or uploaded first.
 * Every account but the unrelated one shares its likes and its upload limit: multi-accounting is
 * not allowed.
 */
const accounts = {
  'the same account': (_prisma, first) => Promise.resolve(first),
  'another account on the same hardware ID': (prisma, first) =>
    createCreator(prisma, { hwids: [nn(first.hwids[0])] }),
  'another account on the same IP': (prisma, first) =>
    createCreator(prisma, { ips: [nn(first.ips[0])] }),
  'an unrelated account': prisma => createCreator(prisma)
} satisfies Record<string, (prisma: PrismaService, first: Creator) => Promise<Creator>>;

const modMetadata = {
  platform: 'WindowsPlayer',
  cpu: 'AMD Ryzen 7 7800X3D 8-Core Processor',
  gpuName: 'NVIDIA GeForce RTX 4080',
  gpuVendor: 'NVIDIA',
  gpuVersion: 'Direct3D 11.0 [level 11.1]'
};

/**
 * The fields the mod sends with an upload, in its order, the optional ones last.
 * The screenshot file follows them.
 */
const modUploadFields: Readonly<Record<string, string>> = {
  cityName: 'Tokyo Bay',
  cityMilestone: '12',
  cityPopulation: '154321',
  shareModIds: 'true',
  modIds: '74604,87755',
  shareRenderSettings: 'true',
  renderSettings: '{"aperture":2.4,"focusDistance":120.5}',
  renderConditions: '{"timeOfDay":18.5,"season":"Autumn","raining":true}',
  metadata: JSON.stringify(modMetadata),
  mapName: 'Lakeland',
  showcasedModId: '87755',
  description: `Sunset over the bay.`
};

// A Full HD JPEG.
const testImage = Bun.file(
  Bun.fileURLToPath(import.meta.resolve('../../../shared/assets/healthcheck-test-image.jpg'))
);

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

    const renderConditions = { timeOfDay: 18.5, season: 'Autumn', raining: true };

    test.each([
      {
        requester: 'the owner',
        shareParadoxModIds: false,
        shareRenderSettings: false,
        expected: { paradoxModIds: modIds, renderSettings, renderConditions }
      },
      {
        requester: 'another creator',
        shareParadoxModIds: false,
        shareRenderSettings: false,
        expected: { paradoxModIds: [], renderSettings: {}, renderConditions: {} }
      },
      {
        requester: 'an anonymous visitor',
        shareParadoxModIds: false,
        shareRenderSettings: false,
        expected: { paradoxModIds: [], renderSettings: {}, renderConditions: {} }
      },
      {
        requester: 'another creator',
        shareParadoxModIds: true,
        shareRenderSettings: false,
        expected: { paradoxModIds: modIds, renderSettings: {}, renderConditions: {} }
      },
      {
        requester: 'an anonymous visitor',
        shareParadoxModIds: false,
        shareRenderSettings: true,
        expected: { paradoxModIds: [], renderSettings, renderConditions }
      }
    ] as const)(
      `shows $requester the mods, render settings and conditions the owner shared: $expected`,
      async ({ requester, shareParadoxModIds, shareRenderSettings, expected }) => {
        const creator = await createCreator(testApp.prisma);
        const other = await createCreator(testApp.prisma);

        const screenshot = await createScreenshot(testApp.prisma, creator, {
          shareParadoxModIds,
          paradoxModIds: modIds,
          shareRenderSettings,
          renderSettings,
          renderConditions
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

    // Mod 1.10.0 reached players on 2025-03-30, capturing the mods and render settings.
    // Mod 2026.0.0 reached them on 2026-01-16, adding the description and both share choices.
    // The mod release recording the render conditions reaches them on 2026-10-04.
    test.each([
      { createdAt: '2025-03-29T23:59:59.999Z', capabilities: [] },
      { createdAt: '2025-03-30T00:00:00.000Z', capabilities: ['paradoxModIds', 'renderSettings'] },
      { createdAt: '2026-01-15T23:59:59.999Z', capabilities: ['paradoxModIds', 'renderSettings'] },
      {
        createdAt: '2026-01-16T00:00:00.000Z',
        capabilities: [
          'description',
          'shareParadoxModIds',
          'paradoxModIds',
          'shareRenderSettings',
          'renderSettings'
        ]
      },
      {
        createdAt: '2026-10-03T23:59:59.999Z',
        capabilities: [
          'description',
          'shareParadoxModIds',
          'paradoxModIds',
          'shareRenderSettings',
          'renderSettings'
        ]
      },
      {
        createdAt: '2026-10-04T00:00:00.000Z',
        capabilities: [
          'description',
          'shareParadoxModIds',
          'paradoxModIds',
          'shareRenderSettings',
          'renderSettings',
          'renderConditions'
        ]
      }
    ])(`lists the fields the mod captured at $createdAt`, async ({ createdAt, capabilities }) => {
      const creator = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(testApp.prisma, creator, {
        createdAt: new Date(createdAt)
      });

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}`
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ capabilities: unknown }>().capabilities).toEqual(capabilities);
    });

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

      test(`formats the showcased mod's size and last release`, async () => {
        const creator = await createCreator(testApp.prisma);

        const mod = await createMod(testApp.prisma, {
          state: 'removedByUser',
          requiredGameVersion: '1.1.12*',
          sizeBytes: 7_327_503_033n,
          knownLastReleasedAt: new Date('2026-08-30T13:52:10Z')
        });

        const screenshot = await createScreenshot(testApp.prisma, creator, {
          showcasedModId: mod.paradoxModId
        });

        setSystemTime(new Date('2026-09-12T10:00:00Z'));

        const response = await testApp.app.inject({
          method: 'GET',
          url: `/api/v1/screenshots/${screenshot.id}`,
          headers: { 'accept-language': 'fr-FR' }
        });

        expect(response.json<{ showcasedMod: unknown }>().showcasedMod).toEqual(
          expectedModPayload(mod, {
            state: 'removed',
            sizeBytes: 7_327_503_033,
            sizeFormatted: '7,3\u202FGo',
            knownLastReleasedAt: '2026-08-30T13:52:10.000Z',
            knownLastReleasedAtFormattedDistance: 'il y a 13 jours'
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
    afterEach(() => {
      setSystemTime();
    });

    test(`returns found mods, skips banned and missing ones, and caches all`, async () => {
      setSystemTime(new Date('2026-09-12T10:00:00Z'));

      const cachedMod = await createMod(testApp.prisma, {
        paradoxModId: 74_604,
        subscribersCount: 1000
      });

      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma),
        { paradoxModIds: [74_604, 87_755, 90_001, 90_002] }
      );

      stubParadoxMod(87_755, {
        // Paradox Mods sends names and descriptions untrimmed, with Windows line endings.
        displayName: ' Hall of Fame\r\n',
        shortDescription: 'Share your cities.\r\nBrowse everyone else’s. ',
        displayImagePath: 'https://mods.paradoxplaza.com/thumbnails/hall-of-fame.jpg',
        subscriptions: 25_000
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
          shortDescription: `Share your cities.\nBrowse everyone else’s.`,
          thumbnailUrl: 'https://mods.paradoxplaza.com/thumbnails/hall-of-fame.jpg',
          tags: ['Code Mod'],
          subscribersCount: 25_000,
          knownLastUpdatedAt: '2026-08-30T14:00:00.000Z',
          state: 'published',
          requiredGameVersion: '1.6.*',
          sizeBytes: 996_437,
          sizeFormatted: '996.4 kB',
          knownLastReleasedAt: '2026-08-30T13:52:10.000Z',
          knownLastReleasedAtFormattedDistance: '13 days ago'
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

    test(`takes the last release from the newest changelog entry, read as UTC`, async () => {
      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma),
        { paradoxModIds: [87_755] }
      );

      stubParadoxMod(87_755, {
        changelog: [
          { modVersion: 3, released: '2026-08-30 13:52:10' },
          { modVersion: 2, released: '2024-08-16 23:22:50' }
        ]
      });

      // A zone-less date read as local time would shift by the process timezone.
      // oxlint-disable node/no-process-env - the timezone is only set through the environment
      const timezone = process.env.TZ;

      process.env.TZ = 'Asia/Tokyo';

      try {
        const response = await testApp.app.inject({
          method: 'GET',
          url: `/api/v1/screenshots/${screenshot.id}/playset`
        });

        expect(response.json<unknown>()).toEqual([
          expect.objectContaining({ knownLastReleasedAt: '2026-08-30T13:52:10.000Z' })
        ]);
      } finally {
        process.env.TZ = nn(timezone);
      }
      // oxlint-enable node/no-process-env
    });

    test(`takes the creation date as the last release of a mod without changelog`, async () => {
      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma),
        { paradoxModIds: [87_755] }
      );

      stubParadoxMod(87_755, { creationDate: '2024-08-16T04:50:51.000Z', changelog: [] });

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}/playset`
      });

      expect(response.json<unknown>()).toEqual([
        expect.objectContaining({ knownLastReleasedAt: '2024-08-16T04:50:51.000Z' })
      ]);
    });

    test.each([
      { language: 'en-US', size: '512', formatted: '512 byte', distance: '13 days ago' },
      { language: 'en-US', size: '670237', formatted: '670.2 kB', distance: '13 days ago' },
      { language: 'en-US', size: '950000', formatted: '950 kB', distance: '13 days ago' },
      // Rounds to 1,000 kB, so it moves to the next unit.
      { language: 'en-US', size: '999950', formatted: '1 MB', distance: '13 days ago' },
      {
        language: 'fr-FR',
        size: '7327503033',
        formatted: '7,3\u202FGo',
        distance: 'il y a 13 jours'
      },
      { language: 'ru-RU', size: '7327503033', formatted: '7,3 ГБ', distance: '13 дней назад' }
    ])(
      `formats a size of $size bytes and the last release for $language`,
      async ({ language, size, formatted, distance }) => {
        setSystemTime(new Date('2026-09-12T10:00:00Z'));

        const screenshot = await createScreenshot(
          testApp.prisma,
          await createCreator(testApp.prisma),
          { paradoxModIds: [87_755] }
        );

        stubParadoxMod(87_755, { metadata: { size_in_memory: size } });

        const response = await testApp.app.inject({
          method: 'GET',
          url: `/api/v1/screenshots/${screenshot.id}/playset`,
          headers: { 'accept-language': language }
        });

        expect(response.json<unknown>()).toEqual([
          expect.objectContaining({
            sizeBytes: Number(size),
            sizeFormatted: formatted,
            knownLastReleasedAtFormattedDistance: distance
          })
        ]);
      }
    );

    test(`maps Paradox Mods states, and lists published mods first`, async () => {
      // Stored before states were: counts as published.
      await createMod(testApp.prisma, { paradoxModId: 74_604, subscribersCount: 10 });

      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma),
        { paradoxModIds: [74_604, 90_001, 90_002, 90_003, 90_004, 90_005] }
      );

      stubParadoxMod(90_001, { state: 'removedByUser', subscriptions: 50_000 });
      stubParadoxMod(90_002, { state: 'autoBlocked', subscriptions: 40_000 });
      stubParadoxMod(90_003, { state: 'disabledByManager', subscriptions: 30_000 });
      stubParadoxMod(90_004, { state: 'underReview', subscriptions: 20_000 });
      stubParadoxMod(90_005, { state: 'published', subscriptions: 100 });

      const captureMessage = spyOn(sentry, 'captureMessage').mockReturnValue('');

      try {
        const response = await testApp.app.inject({
          method: 'GET',
          url: `/api/v1/screenshots/${screenshot.id}/playset`
        });

        expect(
          response.json<Array<{ paradoxModId: number; state: string }>>().map(mod => ({
            paradoxModId: mod.paradoxModId,
            state: mod.state
          }))
        ).toEqual([
          { paradoxModId: 90_005, state: 'published' },
          { paradoxModId: 74_604, state: 'published' },
          { paradoxModId: 90_001, state: 'removed' },
          { paradoxModId: 90_002, state: 'blocked' },
          { paradoxModId: 90_003, state: 'blocked' },
          { paradoxModId: 90_004, state: 'unknown' }
        ]);

        expect(captureMessage.mock.calls).toEqual([
          [
            expect.any(String),
            expect.objectContaining({
              level: 'warning',
              fingerprint: ['paradox-mod-unknown-state', 'underReview']
            })
          ]
        ]);

        // Served from the database, the unknown state is not reported again.
        await testApp.app.inject({
          method: 'GET',
          url: `/api/v1/screenshots/${screenshot.id}/playset`
        });

        expect(captureMessage).toHaveBeenCalledTimes(1);
      } finally {
        captureMessage.mockRestore();
      }
    });

    const noRequiredVersion = { requiredGameVersion: null };

    const noSize = { sizeBytes: null, sizeFormatted: null };

    const noLastRelease = { knownLastReleasedAt: null, knownLastReleasedAtFormattedDistance: null };

    test.each<{ field: string; overrides: Record<string, JsonValue>; nulled: JsonObject }>([
      { field: 'requiredVersion', overrides: { requiredVersion: 16 }, nulled: noRequiredVersion },
      { field: 'requiredVersion', overrides: { requiredVersion: null }, nulled: noRequiredVersion },
      { field: 'requiredVersion', overrides: { requiredVersion: ' ' }, nulled: noRequiredVersion },
      {
        field: 'metadata.size_in_memory',
        overrides: { metadata: { size_in_memory: '' } },
        nulled: noSize
      },
      {
        field: 'metadata.size_in_memory',
        overrides: { metadata: { size_in_memory: '7.3' } },
        nulled: noSize
      },
      {
        field: 'metadata.size_in_memory',
        overrides: { metadata: { size_in_memory: 'big' } },
        nulled: noSize
      },
      { field: 'metadata.size_in_memory', overrides: { metadata: {} }, nulled: noSize },
      { field: 'changelog', overrides: { changelog: 'none' }, nulled: noLastRelease },
      {
        field: 'changelog[].released',
        overrides: { changelog: [{ released: '30/08/2026' }] },
        nulled: noLastRelease
      },
      {
        field: 'creationDate',
        overrides: { changelog: [], creationDate: 'yesterday' },
        nulled: noLastRelease
      }
    ])(
      `leaves out a missing or malformed $field, and reports it`,
      async ({ field, overrides, nulled }) => {
        const screenshot = await createScreenshot(
          testApp.prisma,
          await createCreator(testApp.prisma),
          { paradoxModIds: [87_755] }
        );

        stubParadoxMod(87_755, overrides);

        const captureMessage = spyOn(sentry, 'captureMessage').mockReturnValue('');

        try {
          const response = await testApp.app.inject({
            method: 'GET',
            url: `/api/v1/screenshots/${screenshot.id}/playset`
          });

          expect(response.json<unknown>()).toEqual([
            expect.objectContaining({
              paradoxModId: 87_755,
              requiredGameVersion: '1.6.*',
              sizeBytes: 996_437,
              sizeFormatted: '996.4 kB',
              knownLastReleasedAt: '2026-08-30T13:52:10.000Z',
              knownLastReleasedAtFormattedDistance: expect.any(String),
              ...nulled
            })
          ]);

          expect(captureMessage.mock.calls).toEqual([
            [
              expect.any(String),
              expect.objectContaining({
                level: 'warning',
                fingerprint: ['paradox-mod-malformed-field', field]
              })
            ]
          ]);
        } finally {
          captureMessage.mockRestore();
        }
      }
    );

    test(`leaves out a mod whose details lack a state, without retrying`, async () => {
      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma),
        { paradoxModIds: [87_755] }
      );

      stubParadoxMod(87_755, { state: undefined });

      // Silences the failure logged for the mod.
      const logError = spyOn(Logger.prototype, 'error').mockReturnValue(void 0);

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}/playset`
      });

      logError.mockRestore();

      expect(response.json<unknown>()).toEqual([]);
      expect(fetchStub.requests).toEqual([paradoxModUrl(87_755)]);
    });

    test(`retries a mod Paradox Mods intermittently cannot find, without retiring it`, async () => {
      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma),
        { paradoxModIds: [87_755] }
      );

      fetchStub.respondWithJson(
        paradoxModUrl(87_755),
        { errorCode: 'bad-input', errorMessage: 'Game could not be found.' },
        { status: 400 }
      );

      // Silences the failure logged once the retries are exhausted.
      const logError = spyOn(Logger.prototype, 'error').mockReturnValue(void 0);

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}/playset`
      });

      logError.mockRestore();

      expect(response.json<unknown>()).toEqual([]);

      // The first attempt and three retries.
      expect(fetchStub.requests).toEqual(Array.from({ length: 4 }, () => paradoxModUrl(87_755)));

      stubParadoxMod(87_755);

      const again = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}/playset`
      });

      expect(again.json<unknown>()).toEqual([expect.objectContaining({ paradoxModId: 87_755 })]);
    });

    test(`retries a failing Paradox Mods lookup, then leaves the mod out`, async () => {
      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma),
        { paradoxModIds: [87_755] }
      );

      fetchStub.respondWithJson(
        paradoxModUrl(87_755),
        { error: 'Service Unavailable' },
        { status: 503 }
      );

      // Silences the failure logged once the retries are exhausted.
      const logError = spyOn(Logger.prototype, 'error').mockReturnValue(void 0);

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}/playset`
      });

      logError.mockRestore();

      expect(response.statusCode).toBe(200);
      expect(response.json<unknown>()).toEqual([]);

      // The first attempt and three retries.
      expect(fetchStub.requests).toEqual(Array.from({ length: 4 }, () => paradoxModUrl(87_755)));

      expect(await testApp.prisma.mod.count()).toBe(0);
    });

    test(`leaves out a mod whose details fail validation, without retrying`, async () => {
      const screenshot = await createScreenshot(
        testApp.prisma,
        await createCreator(testApp.prisma),
        { paradoxModIds: [87_755] }
      );

      stubParadoxMod(87_755, { subscriptions: 'many' });

      // Silences the failure logged for the mod.
      const logError = spyOn(Logger.prototype, 'error').mockReturnValue(void 0);

      const response = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}/playset`
      });

      logError.mockRestore();

      expect(response.statusCode).toBe(200);
      expect(response.json<unknown>()).toEqual([]);
      expect(fetchStub.requests).toEqual([paradoxModUrl(87_755)]);
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

    test.each(['random=-1', 'random=2&popular=-1', `random=${Number.MAX_SAFE_INTEGER}&popular=1`])(
      `returns 400 for weights the pick cannot use: %s`,
      async query => {
        const response = await testApp.app.inject({
          method: 'GET',
          url: `/api/v1/screenshots/weighted?${query}`
        });

        expect(response.statusCode).toBe(400);

        expect(response.json<unknown>()).toEqual({
          statusCode: 400,
          message:
            `Algorithm weights must be positive integers or zero, ` +
            `totaling at most ${Number.MAX_SAFE_INTEGER}.`,
          error: 'Bad Request'
        });
      }
    );

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
      'the same account',
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

  describe('POST /api/v1/screenshots', () => {
    // Every upload lists them; a test only asserts on the lookups when it cares.
    beforeEach(() => {
      stubParadoxMod(74_604);
      stubParadoxMod(87_755);
    });

    afterEach(() => {
      setSystemTime();
    });

    test(`stores a screenshot uploaded as the mod sends it`, async () => {
      setSystemTime(new Date('2026-09-12T10:00:00Z'));

      const creator = await createCreator(testApp.prisma);

      const response = await upload(modHeaders(creator));

      expect(response.statusCode).toBe(201);

      const screenshot = await testApp.prisma.screenshot.findFirstOrThrow();

      await testApp.backgroundTasks.settled();

      const blobDirectory = `${creator.id}/${screenshot.id}`;

      const blobNameBase = `${blobDirectory}/tokyo-bay-by-mayor-1-2026-09-12-10-00-00`;

      expect(screenshot).toMatchObject({
        creatorId: creator.id,
        hwid: nn(creator.hwids[0]),
        ip: nn(creator.ips[0]),
        createdAt: new Date('2026-09-12T10:00:00Z'),
        cityName: 'Tokyo Bay',
        cityMilestone: 12,
        cityPopulation: 154_321,
        mapName: 'Lakeland',
        showcasedModId: 87_755,
        description: 'Sunset over the bay.',
        shareParadoxModIds: true,
        paradoxModIds: [74_604, 87_755],
        shareRenderSettings: true,
        renderSettings: { aperture: 2.4, focusDistance: 120.5 },
        renderConditions: { timeOfDay: 18.5, season: 'Autumn', raining: true },
        metadata: modMetadata,
        isReported: false,
        imageUrlThumbnail: `${blobNameBase}-thumbnail.jpg`,
        imageUrlFHD: `${blobNameBase}-fhd.jpg`,
        imageUrl4K: `${blobNameBase}-4k.jpg`
      });

      expect(response.json<unknown>()).toEqual(expectedScreenshotPayload(screenshot, creator));

      const images = await allFulfilled(
        Array.from(testApp.screenshotStorage.blobs, async ([blobName, buffer]) => {
          const { format, width, height } = await sharp(buffer).metadata();

          return { blobName, format, width, height };
        })
      );

      // Processing never enlarges the Full HD source.
      expect(images).toEqual([
        { blobName: `${blobNameBase}-thumbnail.jpg`, format: 'jpeg', width: 256, height: 144 },
        { blobName: `${blobNameBase}-fhd.jpg`, format: 'jpeg', width: 1920, height: 1080 },
        { blobName: `${blobNameBase}-4k.jpg`, format: 'jpeg', width: 1920, height: 1080 }
      ]);

      const showcasedMod = await testApp.prisma.mod.findUniqueOrThrow({
        where: { paradoxModId: 87_755 }
      });

      const single = await testApp.app.inject({
        method: 'GET',
        url: `/api/v1/screenshots/${screenshot.id}`
      });

      expect(single.json<unknown>()).toEqual(
        expectedScreenshotPayload(screenshot, creator, {
          showcasedMod: expectedModPayload(showcasedMod),
          __favorited: false
        })
      );

      const list = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/screenshots?creatorId=me',
        headers: modHeaders(creator)
      });

      expect(list.json<unknown>()).toEqual([
        expectedScreenshotPayload(screenshot, creator, { __favorited: false })
      ]);
    });

    test(`runs the translation, embeddings, and mod cache warmup in the background`, async () => {
      const creator = await createCreator(testApp.prisma);

      const response = await upload(modHeaders(creator), {
        ...modUploadFields,
        cityName: '東京湾'
      });

      expect(response.statusCode).toBe(201);
      expect(response.json<unknown>()).toEqual(expect.objectContaining({ cityNameLocale: null }));

      const { id } = response.json<{ id: string }>();

      await testApp.backgroundTasks.settled();

      expect(testApp.aiTranslator.requests).toEqual([
        { kind: 'cityName', input: '東京湾', creatorId: creator.id }
      ]);

      const screenshot = await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id } });

      expect(testApp.screenshotSimilarityDetector.embeddingUpdates).toEqual([
        [{ id, imageUrlOrBuffer: nn(testApp.screenshotStorage.blobs.get(screenshot.imageUrlFHD)) }]
      ]);

      expect(fetchStub.requests.toSorted()).toEqual([paradoxModUrl(74_604), paradoxModUrl(87_755)]);

      const single = await testApp.app.inject({ method: 'GET', url: `/api/v1/screenshots/${id}` });

      expect(single.json<unknown>()).toEqual(
        expect.objectContaining({
          cityName: '東京湾',
          cityNameLocale: 'ja',
          cityNameLatinized: '東京湾 (transliterated)',
          cityNameTranslated: '東京湾 (translated)',
          showcasedMod: expect.objectContaining({ paradoxModId: 87_755, name: 'Mod 87755' })
        })
      );

      // Served from the mod cache.
      expect(fetchStub.requests).toHaveLength(2);
    });

    test(`stores what the mod sends without the optional fields, sharing nothing`, async () => {
      const creator = await createCreator(testApp.prisma);

      const response = await upload(modHeaders(creator), {
        cityName: 'Tokyo Bay',
        cityMilestone: '0',
        cityPopulation: '0',
        shareModIds: 'false',
        modIds: '',
        shareRenderSettings: 'false',
        renderSettings: '{}',
        metadata: '{}'
      });

      expect(response.statusCode).toBe(201);

      const screenshot = await testApp.prisma.screenshot.findFirstOrThrow();

      expect(screenshot).toMatchObject({
        cityMilestone: 0,
        cityPopulation: 0,
        mapName: null,
        showcasedModId: null,
        description: null,
        shareParadoxModIds: false,
        paradoxModIds: [],
        shareRenderSettings: false,
        renderSettings: {},
        renderConditions: {},
        metadata: {}
      });

      expect(response.json<unknown>()).toEqual(expectedScreenshotPayload(screenshot, creator));
    });

    test.each([
      {
        field: 'cityName',
        value: 'Tokyo!',
        error: 'InvalidCityNameError',
        message:
          `City name "Tokyo!" is invalid, it must contain only letters, numbers, spaces, ` +
          `hyphens, apostrophes, commas, and middle dots, with at least one letter or number, ` +
          `and be between 1 and 35 characters long.`
      },
      {
        field: 'cityMilestone',
        value: '21',
        error: 'InvalidPayloadError',
        message: `Invalid milestone, it must be a positive integer between 0 and 20.`
      },
      {
        field: 'cityPopulation',
        value: '-1',
        error: 'InvalidPayloadError',
        message: `Invalid population number, it must be a positive integer.`
      },
      {
        field: 'modIds',
        value: '74604;87755',
        error: 'InvalidPayloadError',
        message: `Mod IDs must be positive integers and separated by a comma.`
      },
      {
        field: 'showcasedModId',
        value: 'hall-of-fame',
        error: 'InvalidPayloadError',
        message: `Mod IDs must be positive integers and separated by a comma.`
      },
      {
        field: 'renderSettings',
        value: '[]',
        error: 'InvalidPayloadError',
        message: `Invalid JSON for render settings field (expected a JSON object).`
      },
      {
        field: 'renderConditions',
        value: '{"cameraPosition":[12,40,-3]}',
        error: 'InvalidPayloadError',
        message:
          `Invalid JSON for render conditions field (expected a number, string, or boolean ` +
          `value for the key "cameraPosition", got "[ 12, 40, -3 ]").`
      },
      {
        field: 'renderConditions',
        value: JSON.stringify({ season: 'x'.repeat(16_384) }),
        error: 'InvalidPayloadError',
        message: `Render conditions field must be at most 16384 characters long.`
      },
      {
        field: 'metadata',
        value: 'null',
        error: 'InvalidPayloadError',
        message: `Invalid JSON for the metadata field (expected a JSON object).`
      },
      {
        field: 'description',
        value: 'x'.repeat(4001),
        error: 'InvalidPayloadError',
        message: `Description must be at most 4000 characters long.`
      }
    ])(`returns 400 for an invalid $field`, async ({ field, value, error, message }) => {
      const creator = await createCreator(testApp.prisma);

      const response = await upload(modHeaders(creator), { ...modUploadFields, [field]: value });

      expect(response.statusCode).toBe(400);
      expect(response.json<unknown>()).toEqual({ statusCode: 400, message, error });

      await expectNothingStored();
    });

    test.each([
      {
        markdown: 'image',
        description: `Dusk. ![Skyline](https://example.com/skyline.png)`,
        message: `Description cannot contain image markdown, found "![Skyline](https://example.com/skyline.png)".`
      },
      {
        markdown: 'link',
        description: `See [my city](https://example.com) for more.`,
        message: `Description cannot contain link markdown, found "[my city](https://example.com)".`
      }
    ])(`returns 400 for $markdown markdown in a description`, async ({ description, message }) => {
      const creator = await createCreator(testApp.prisma);

      const response = await upload(modHeaders(creator), { ...modUploadFields, description });

      expect(response.statusCode).toBe(400);

      expect(response.json<unknown>()).toEqual({
        statusCode: 400,
        message,
        error: 'InvalidPayloadError'
      });

      await expectNothingStored();
    });

    test.each(
      ['cityName', 'cityMilestone', 'cityPopulation'].flatMap(field => [
        {
          field,
          state: 'missing',
          fields: Object.fromEntries(
            Object.entries(modUploadFields).filter(([name]) => name != field)
          )
        },
        { field, state: 'blank', fields: { ...modUploadFields, [field]: '  ' } }
      ])
    )(`returns 400 for a $state $field`, async ({ field, fields }) => {
      const creator = await createCreator(testApp.prisma);

      const response = await upload(modHeaders(creator), fields);

      expect(response.statusCode).toBe(400);

      expect(response.json<unknown>()).toEqual({
        statusCode: 400,
        message: `Expected a multipart field named '${field}'.`,
        error: 'InvalidPayloadError'
      });

      await expectNothingStored();
    });

    test(`returns 400 without the screenshot file`, async () => {
      const creator = await createCreator(testApp.prisma);

      const response = await upload(modHeaders(creator), modUploadFields, null);

      expect(response.statusCode).toBe(400);

      expect(response.json<unknown>()).toEqual({
        statusCode: 400,
        message: `Expected a file-field named 'screenshot'.`,
        error: 'InvalidPayloadError'
      });

      await expectNothingStored();
    });

    test(`returns 400 for a file that is not an image`, async () => {
      const creator = await createCreator(testApp.prisma);

      const response = await upload(
        modHeaders(creator),
        modUploadFields,
        new Blob([`Not a screenshot.`])
      );

      expect(response.statusCode).toBe(400);

      expect(response.json<unknown>()).toEqual({
        statusCode: 400,
        message: `Invalid image format, expected a JPEG file.`,
        error: 'InvalidImageFormatError'
      });

      await expectNothingStored();
    });

    test(`returns 401 without credentials`, async () => {
      const response = await upload({});

      expect(response.statusCode).toBe(401);

      expect(response.json<unknown>()).toEqual({
        statusCode: 401,
        message: `Request not authenticated.`,
        error: 'UnauthorizedError'
      });

      await expectNothingStored();
    });

    test(`returns 403 for a banned creator`, async () => {
      const creator = await createCreator(testApp.prisma);

      await createBan(testApp.prisma, { creatorId: creator.id });

      const response = await upload(modHeaders(creator));

      expect(response.statusCode).toBe(403);

      expect(response.json<unknown>()).toEqual({
        statusCode: 403,
        message: expect.stringMatching(
          /^Creator "Mayor 1" is banned for the following reason: uploading inappropriate/u
        ),
        error: 'BannedCreatorError'
      });

      await expectNothingStored();
    });

    describe('24h upload limit', () => {
      const limit = config.screenshots.limitPer24h;

      test.each([
        'the same account',
        'another account on the same hardware ID',
        'another account on the same IP'
      ] as const)(`returns 403 once the limit is reached by %s`, async account => {
        const first = await createCreator(testApp.prisma);

        const oldest = await createScreenshot(testApp.prisma, first, {
          createdAt: dfns.subHours(new Date(), 23)
        });

        await allFulfilled(
          Array.from({ length: limit - 1 }, () => createScreenshot(testApp.prisma, first))
        );

        const response = await upload(modHeaders(await accounts[account](testApp.prisma, first)));

        expect(response.statusCode).toBe(403);

        // The oldest upload leaves the 24h window first.
        expect(response.json<unknown>()).toEqual({
          statusCode: 403,
          message:
            `You can only upload a maximum of ${limit} screenshots every 24 hours. ` +
            `Your next slot will not open before ` +
            `${dfns.addDays(oldest.createdAt, 1).toLocaleString()} UTC.`,
          error: 'ScreenshotRateLimitExceededError'
        });

        expect(await testApp.prisma.screenshot.count()).toBe(limit);
        expect(testApp.screenshotStorage.blobs.size).toBe(0);
      });

      test(`accepts the last upload of the limit, not counting older ones`, async () => {
        const creator = await createCreator(testApp.prisma);

        await createScreenshot(testApp.prisma, creator, {
          createdAt: dfns.subHours(new Date(), 25)
        });

        await allFulfilled(
          Array.from({ length: limit - 1 }, () => createScreenshot(testApp.prisma, creator))
        );

        const response = await upload(modHeaders(creator));

        expect(response.statusCode).toBe(201);
        expect(await testApp.prisma.screenshot.count()).toBe(limit + 1);
      });
    });

    /**
     * Sends an upload the way the mod encodes it: the fields in order, then the screenshot file.
     */
    async function upload(
      headers: Readonly<Record<string, string>>,
      fields = modUploadFields,
      screenshot: Blob | null = testImage
    ): Promise<Awaited<ReturnType<TestApp['app']['inject']>>> {
      const form = new FormData();

      for (const [name, value] of Object.entries(fields)) {
        form.append(name, value);
      }

      if (screenshot) {
        // The mod names its JPEG this way.
        form.append('screenshot', screenshot, 'screenshot.png');
      }

      // Encodes the form as a multipart body with its boundary.
      const request = new Request('http://localhost', { method: 'POST', body: form });

      return testApp.app.inject({
        method: 'POST',
        url: '/api/v1/screenshots',
        headers: { ...headers, 'content-type': nn(request.headers.get('content-type')) },
        payload: Buffer.from(await request.arrayBuffer())
      });
    }

    async function expectNothingStored(): Promise<void> {
      expect(await testApp.prisma.screenshot.count()).toBe(0);
      expect(testApp.screenshotStorage.blobs.size).toBe(0);
    }
  });

  // The mod reads __favorited from the weighted route, the viewer from the others.
  test.each([
    { account: 'the same account', favorited: true },
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

  describe('PUT /api/v1/screenshots/:id', () => {
    test.each([
      {
        body: { cityName: '' },
        message:
          `City name "" is invalid, it must contain only letters, numbers, spaces, hyphens, ` +
          `apostrophes, commas, and middle dots, with at least one letter or number, and be ` +
          `between 1 and 35 characters long.`,
        error: 'InvalidCityNameError'
      },
      {
        body: { description: 'x'.repeat(4001) },
        message: `Description must be at most 4000 characters long.`,
        error: 'InvalidPayloadError'
      },
      {
        body: { description: `Dusk. ![Skyline](https://example.com/skyline.png)` },
        message: `Description cannot contain image markdown, found "![Skyline](https://example.com/skyline.png)".`,
        error: 'InvalidPayloadError'
      },
      {
        body: { description: `See [my city](https://example.com) for more.` },
        message: `Description cannot contain link markdown, found "[my city](https://example.com)".`,
        error: 'InvalidPayloadError'
      }
    ])(`rejects $body as the upload does`, async ({ body, message, error }) => {
      const creator = await createCreator(testApp.prisma);
      const screenshot = await createScreenshot(testApp.prisma, creator);

      const response = await testApp.app.inject({
        method: 'PUT',
        url: `/api/v1/screenshots/${screenshot.id}`,
        headers: modHeaders(creator),
        payload: body
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<unknown>()).toEqual({ statusCode: 400, message, error });

      expect(
        await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: screenshot.id } })
      ).toEqual(screenshot);
    });

    test(`caches a newly showcased mod once the update is committed`, async () => {
      const creator = await createCreator(testApp.prisma);
      const screenshot = await createScreenshot(testApp.prisma, creator, { showcasedModId: null });

      stubParadoxMod(87_755);

      const response = await testApp.app.inject({
        method: 'PUT',
        url: `/api/v1/screenshots/${screenshot.id}`,
        headers: modHeaders(creator),
        payload: { showcasedModId: '87755' }
      });

      expect(response.statusCode).toBe(200);

      await testApp.backgroundTasks.settled();

      expect(await testApp.prisma.mod.count({ where: { paradoxModId: 87_755 } })).toBe(1);
    });

    test(`puts a newly showcased mod up for moderation`, async () => {
      const creator = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(testApp.prisma, creator, {
        showcasedModId: 74_604,
        isShowcasedModValidated: true
      });

      stubParadoxMod(87_755);

      const response = await testApp.app.inject({
        method: 'PUT',
        url: `/api/v1/screenshots/${screenshot.id}`,
        headers: modHeaders(creator),
        payload: { showcasedModId: '87755' }
      });

      expect(response.statusCode).toBe(200);

      expect(
        await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: screenshot.id } })
      ).toMatchObject({ showcasedModId: 87_755, isShowcasedModValidated: false });
    });

    test(`keeps the moderation outcome of a showcased mod sent again`, async () => {
      const creator = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(testApp.prisma, creator, {
        showcasedModId: 87_755,
        isShowcasedModValidated: true
      });

      const response = await testApp.app.inject({
        method: 'PUT',
        url: `/api/v1/screenshots/${screenshot.id}`,
        headers: modHeaders(creator),
        payload: { showcasedModId: '87755' }
      });

      expect(response.statusCode).toBe(200);

      expect(
        await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: screenshot.id } })
      ).toMatchObject({ showcasedModId: 87_755, isShowcasedModValidated: true });
    });

    test(`keeps a pending translation when the city name is left alone`, async () => {
      const creator = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(testApp.prisma, creator, {
        needsTranslation: true
      });

      const response = await testApp.app.inject({
        method: 'PUT',
        url: `/api/v1/screenshots/${screenshot.id}`,
        headers: modHeaders(creator),
        payload: { description: `Sunset over the bay.` }
      });

      expect(response.statusCode).toBe(200);

      expect(
        await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: screenshot.id } })
      ).toMatchObject({ description: `Sunset over the bay.`, needsTranslation: true });
    });

    test(`keeps a stored description it now rejects when the edit omits it`, async () => {
      const creator = await createCreator(testApp.prisma);

      const screenshot = await createScreenshot(testApp.prisma, creator, {
        description: `See [my city](https://example.com) for more.`
      });

      const response = await testApp.app.inject({
        method: 'PUT',
        url: `/api/v1/screenshots/${screenshot.id}`,
        headers: modHeaders(creator),
        payload: { shareRenderSettings: false }
      });

      expect(response.statusCode).toBe(200);

      expect(
        await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: screenshot.id } })
      ).toMatchObject({
        description: `See [my city](https://example.com) for more.`,
        shareRenderSettings: false
      });
    });
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
        url: `/api/v1/screenshots/${identifiers.unknownScreenshotId}${path}`
      });

      expect(response.statusCode).toBe(404);

      expect(response.json<unknown>()).toEqual({
        statusCode: 404,
        message: `Could not find resource with ID "${identifiers.unknownScreenshotId}".`,
        error: 'NotFoundByIdError'
      });
    }
  );
});

describe('validateCityName', () => {
  test.each([
    'Tokyo Bay',
    'Paris, Texas',
    `L'Isle-d'Abeau`,
    'Val d’Isère',
    'Санкт-Петербург',
    '東京',
    '北京、上海',
    // One character suffices in Chinese.
    '京',
    '亚历山大·港',
    'Ville•Nord',
    // Letters with combining marks.
    'मुंबई',
    'กรุงเทพ',
    '2049',
    'x'.repeat(35),
    // Counted in characters, not UTF-16 code units.
    '𠮷'.repeat(35)
  ])(`accepts "%s"`, name => {
    expect(validateCityName(name)).toBe(name);
  });

  test.each([
    '',
    'x'.repeat(36),
    'Tokyo!',
    'Tokyo_Bay',
    'Tokyo\tBay',
    'Tokyo 🗼',
    '   ',
    ',,,',
    '-',
    // More combining marks on one letter than any script needs.
    'á́́́'
  ])(`rejects "%s"`, name => {
    expect(() => validateCityName(name)).toThrow(
      `City name "${name}" is invalid, it must contain only letters, numbers, spaces, ` +
        `hyphens, apostrophes, commas, and middle dots, with at least one letter or number, ` +
        `and be between 1 and 35 characters long.`
    );
  });

  test(`trims surrounding whitespace`, () => {
    expect(validateCityName('  Tokyo Bay \n')).toBe('Tokyo Bay');
  });
});

describe('validateMilestone', () => {
  test.each([
    { milestone: '0', parsed: 0 },
    { milestone: '20', parsed: 20 },
    { milestone: '12.7', parsed: 12 }
  ])(`parses "$milestone" as $parsed`, ({ milestone, parsed }) => {
    expect(validateMilestone(milestone)).toBe(parsed);
  });

  test.each(['-1', '21', 'twelve'])(`rejects "%s"`, milestone => {
    expect(() => validateMilestone(milestone)).toThrow(
      `Invalid milestone, it must be a positive integer between 0 and 20.`
    );
  });
});

describe('validatePopulation', () => {
  test.each([
    { population: '0', parsed: 0 },
    { population: '5000000', parsed: 5_000_000 },
    { population: '154321.9', parsed: 154_321 }
  ])(`parses "$population" as $parsed`, ({ population, parsed }) => {
    expect(validatePopulation(population)).toBe(parsed);
  });

  test.each(['-1', '5000001', 'many'])(`rejects "%s"`, population => {
    expect(() => validatePopulation(population)).toThrow(
      `Invalid population number, it must be a positive integer.`
    );
  });
});

describe('validateDescription', () => {
  test.each([undefined, '', ' \n '])(`treats %p as no description`, description => {
    expect(validateDescription(description)).toBeUndefined();
  });

  test(`trims surrounding whitespace`, () => {
    expect(validateDescription('  Sunset over the bay. \n')).toBe(`Sunset over the bay.`);
  });

  test(`accepts 4000 characters`, () => {
    expect(validateDescription('x'.repeat(4000))).toBe('x'.repeat(4000));
  });

  test(`rejects 4001 characters`, () => {
    expect(() => validateDescription('x'.repeat(4001))).toThrow(
      `Description must be at most 4000 characters long.`
    );
  });

  test.each([
    `**Bold** skyline, a * stray asterisk, and 2 * 3 = 6.`,
    `- Harbor district\n- Old town -- rebuilt after the flood`,
    `Full album at https://example.com/skyline.png`,
    `Tokyo [Japan] (2026)`,
    `Downtown (the old part) and the harbor [sic]`,
    `(see [the harbor])`,
    `Wow! [Really]`,
    `[unclosed](https://example.com`
  ])(`accepts "%s"`, description => {
    expect(validateDescription(description)).toBe(description);
  });

  test.each([
    {
      description: `![Skyline](https://example.com/skyline.png)`,
      message: `Description cannot contain image markdown, found "![Skyline](https://example.com/skyline.png)".`
    },
    {
      description: `Dusk ![](https://example.com/skyline.png) over the bay.`,
      message: `Description cannot contain image markdown, found "![](https://example.com/skyline.png)".`
    },
    {
      description: `See [my city](https://example.com) for more.`,
      message: `Description cannot contain link markdown, found "[my city](https://example.com)".`
    },
    {
      // With no space between the brackets and the parentheses, the game renders a link.
      description: `Tokyo [Japan](2026)`,
      message: `Description cannot contain link markdown, found "[Japan](2026)".`
    }
  ])(`rejects "$description"`, ({ description, message }) => {
    expect(() => validateDescription(description)).toThrow(message);
  });
});

describe('validateModIds', () => {
  test.each([
    { csv: undefined, modIds: [] },
    { csv: '', modIds: [] },
    { csv: '87755', modIds: [87_755] },
    { csv: '74604,87755,74604', modIds: [74_604, 87_755] },
    { csv: ' 74604 , 87755 ', modIds: [74_604, 87_755] },
    { csv: '87755.9', modIds: [87_755] }
  ])(`parses $csv as $modIds, deduplicated`, ({ csv, modIds }) => {
    expect<readonly number[]>(Array.from(validateModIds(csv))).toEqual(modIds);
  });

  test.each(['0', '-87755', 'hall-of-fame', '74604,', '74604;87755', 'Infinity', '1e30'])(
    `rejects "%s"`,
    csv => {
      expect(() => validateModIds(csv)).toThrow(
        `Mod IDs must be positive integers and separated by a comma.`
      );
    }
  );
});

describe('validateRenderSettings', () => {
  test.each([
    { json: undefined, settings: {} },
    { json: '', settings: {} },
    { json: '{}', settings: {} },
    { json: '{"aperture":2.4,"exposure":-1}', settings: { aperture: 2.4, exposure: -1 } }
  ])(`parses $json as $settings`, ({ json, settings }) => {
    expect(validateRenderSettings(json)).toEqual(settings);
  });

  test.each([
    { json: '[2.4]', reason: 'expected a JSON object' },
    { json: 'null', reason: 'expected a JSON object' },
    { json: '2.4', reason: 'expected a JSON object' },
    {
      json: '{"aperture":"2.4"}',
      reason: 'expected a number value for the key "aperture", got ""2.4""'
    },
    { json: '{"aperture":', reason: 'JSON Parse error: Unexpected EOF' }
  ])(`rejects $json: $reason`, ({ json, reason }) => {
    expect(() => validateRenderSettings(json)).toThrow(
      `Invalid JSON for render settings field (${reason}).`
    );
  });
});

describe('validateRenderConditions', () => {
  test.each([
    { json: undefined, conditions: {} },
    { json: '', conditions: {} },
    { json: '{}', conditions: {} },
    {
      json: '{"timeOfDay":18.5,"season":"Autumn","raining":false}',
      conditions: { timeOfDay: 18.5, season: 'Autumn', raining: false }
    }
  ])(`parses $json as $conditions`, ({ json, conditions }) => {
    expect(validateRenderConditions(json)).toEqual(conditions);
  });

  // `{"season":""}` is 13 characters long.
  test(`accepts a field of up to 16384 characters`, () => {
    const season = 'x'.repeat(16_384 - 13);

    expect(validateRenderConditions(JSON.stringify({ season }))).toEqual({ season });

    expect(() => validateRenderConditions(JSON.stringify({ season: `${season}x` }))).toThrow(
      `Render conditions field must be at most 16384 characters long.`
    );
  });

  test.each([
    { json: '["Autumn"]', reason: 'expected a JSON object' },
    { json: 'null', reason: 'expected a JSON object' },
    {
      json: '{"season":null}',
      reason: 'expected a number, string, or boolean value for the key "season", got "null"'
    },
    {
      json: '{"sun":{"elevation":12}}',
      reason:
        'expected a number, string, or boolean value for the key "sun", got "{ elevation: 12, }"'
    },
    { json: '{"season":', reason: 'JSON Parse error: Unexpected EOF' }
  ])(`rejects $json: $reason`, ({ json, reason }) => {
    expect(() => validateRenderConditions(json)).toThrow(
      `Invalid JSON for render conditions field (${reason}).`
    );
  });
});

describe('validateMetadata', () => {
  test.each([undefined, ''])(`treats %p as empty metadata`, json => {
    expect(validateMetadata(json)).toEqual({});
  });

  test(`accepts any JSON object`, () => {
    expect(validateMetadata('{"platform":"WindowsPlayer","gpu":{"vram":[8]}}')).toEqual({
      platform: 'WindowsPlayer',
      gpu: { vram: [8] }
    });
  });

  test.each([
    { json: '["WindowsPlayer"]', reason: 'expected a JSON object' },
    { json: 'null', reason: 'expected a JSON object' },
    { json: '"WindowsPlayer"', reason: 'expected a JSON object' },
    { json: '{"platform":', reason: 'JSON Parse error: Unexpected EOF' }
  ])(`rejects $json: $reason`, ({ json, reason }) => {
    expect(() => validateMetadata(json)).toThrow(
      `Invalid JSON for the metadata field (${reason}).`
    );
  });
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

/**
 * Answers the Paradox Mods lookup of `modId` with a mod named after its ID, unless overridden.
 * An `undefined` override leaves the field out.
 */
function stubParadoxMod(
  modId: number,
  overrides: Readonly<Record<string, JsonValue | undefined>> = {}
): void {
  const modDetail: Record<string, JsonValue | undefined> = {
    modId: String(modId),
    author: 'toverux',
    displayName: `Mod ${modId}`,
    shortDescription: `Adds a few things to the game.`,
    displayImagePath: `https://mods.paradoxplaza.com/thumbnails/${modId}.jpg`,
    tags: ['Code Mod'],
    subscriptions: 1000,
    latestUpdate: '2026-08-30T14:00:00Z',
    state: 'published',
    requiredVersion: '1.6.*',
    creationDate: '2024-08-16T04:50:51.000Z',
    metadata: { relevance_score: 0, size_in_memory: '996437' },
    changelog: [
      { modVersion: 2, released: '2024-08-16 23:22:50', userModVersion: '1.0.1' },
      { modVersion: 3, released: '2026-08-30 13:52:10', userModVersion: '1.1.0' }
    ],
    ...overrides
  };

  fetchStub.respondWithJson(paradoxModUrl(modId), {
    modDetail: Object.fromEntries(
      Object.entries(modDetail).filter(
        (field): field is [string, JsonValue] => field[1] !== undefined
      )
    )
  });
}
