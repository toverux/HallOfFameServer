import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { nn } from '../../shared/utils/type-assertion';
import { config } from '../config';
import { createBan, createCreator } from '../testing/factories';
import * as identifiers from '../testing/identifiers';
import { createTestApp, modHeaders, type TestApp } from '../testing/test-app';

describe('CreatorAuthorizationGuard', () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp.app.close();
  });

  describe('Creator scheme, sent by the mod', () => {
    test(`authenticates an existing creator`, async () => {
      const creator = await createCreator(testApp.prisma);

      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/me',
        headers: modHeaders(creator)
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ id: string }>().id).toBe(creator.id);
    });

    test(`creates the account on first authentication`, async () => {
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/me',
        headers: modHeaders({
          creatorName: 'New Mayor',
          creatorId: identifiers.unusedCreatorId,
          creatorIdProvider: 'local',
          hwids: [identifiers.hwid1],
          ips: [identifiers.ip1]
        })
      });

      expect(response.statusCode).toBe(200);

      const creator = await testApp.prisma.creator.findUniqueOrThrow({
        where: { creatorId: identifiers.unusedCreatorId }
      });

      expect(creator).toMatchObject({
        creatorName: 'New Mayor',
        creatorNameSlug: 'new-mayor',
        creatorIdProvider: 'local',
        hwids: [identifiers.hwid1],
        ips: [identifiers.ip1]
      });

      expect(response.json<unknown>()).toEqual({
        id: creator.id,
        creatorName: 'New Mayor',
        creatorNameSlug: 'new-mayor',
        creatorNameLocale: null,
        creatorNameLatinized: null,
        creatorNameTranslated: null,
        createdAt: creator.createdAt.toISOString(),
        viewerUrl: `${config.http.baseUrl}/api/v1/creators/${creator.id}/viewer`,
        viewerClicksCount: 0,
        socials: []
      });
    });

    test(`requests a translation of a new account's non-Latin name`, async () => {
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/me',
        headers: modHeaders({
          creatorName: '東京市長',
          creatorId: identifiers.unusedCreatorId,
          creatorIdProvider: 'paradox',
          hwids: [identifiers.hwid1],
          ips: [identifiers.ip1]
        })
      });

      expect(response.statusCode).toBe(200);

      expect(testApp.aiTranslator.requests).toEqual([
        { kind: 'creatorName', input: '東京市長', creatorId: response.json<{ id: string }>().id }
      ]);
    });

    test(`rejects a name claimed by another Creator ID`, async () => {
      const creator = await createCreator(testApp.prisma);

      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/me',
        headers: modHeaders({ ...creator, creatorId: identifiers.unusedCreatorId })
      });

      expect(response.statusCode).toBe(401);

      expect(response.json<unknown>()).toEqual({
        statusCode: 401,
        message: expect.stringMatching(/^Incorrect Creator ID for user "Mayor 1"\. /u),
        error: 'IncorrectCreatorIdError'
      });
    });
  });

  describe('CreatorID scheme', () => {
    test(`authenticates an existing creator`, async () => {
      const creator = await createCreator(testApp.prisma);

      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/me',
        headers: { authorization: `CreatorID ${creator.creatorId}` }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ id: string }>().id).toBe(creator.id);
    });

    test(`rejects a Creator ID matching no creator`, async () => {
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/me',
        headers: { authorization: `CreatorID ${identifiers.unusedCreatorId}` }
      });

      expect(response.statusCode).toBe(401);

      expect(response.json<unknown>()).toEqual({
        statusCode: 401,
        message: `No Creator with this Creator ID was found.`,
        error: 'CreatorNotFoundError'
      });
    });
  });

  test(`lets an anonymous request through to a public route`, async () => {
    const creator = await createCreator(testApp.prisma);

    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/v1/creators/${creator.id}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ id: string }>().id).toBe(creator.id);
  });

  describe('malformed Authorization header', () => {
    test(`rejects an unknown scheme`, async () => {
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/me',
        headers: { authorization: 'Bearer 00000000-0000-4000-8000-000000000001' }
      });

      expect(response.statusCode).toBe(401);

      expect(response.json<unknown>()).toEqual({
        statusCode: 401,
        message: `Invalid Authorization header (Invalid Authorization scheme, expected "Creator" or "CreatorID".).`,
        error: 'UnauthorizedError'
      });
    });

    test(`rejects a Creator header without a hardware ID`, async () => {
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/me',
        headers: {
          authorization: `Creator name=Mayor&id=${identifiers.unusedCreatorId}&provider=paradox`
        }
      });

      expect(response.statusCode).toBe(401);

      expect(response.json<unknown>()).toEqual({
        statusCode: 401,
        message: `Invalid Authorization header (HWID must be a non-empty string.).`,
        error: 'UnauthorizedError'
      });
    });

    test(`rejects a Creator ID that is not a UUID v4`, async () => {
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/me',
        headers: { authorization: 'CreatorID toverux' }
      });

      expect(response.statusCode).toBe(400);

      expect(response.json<unknown>()).toEqual({
        statusCode: 400,
        message: `Invalid Creator ID "toverux", an UUID v4 sequence was expected.`,
        error: 'InvalidCreatorIdError'
      });
    });
  });

  describe('bans', () => {
    test(`rejects a banned creator`, async () => {
      const creator = await createCreator(testApp.prisma);

      await createBan(testApp.prisma, { creatorId: creator.id });

      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/me',
        headers: { authorization: `CreatorID ${creator.creatorId}` }
      });

      expect(response.statusCode).toBe(403);

      expect(response.json<unknown>()).toEqual({
        statusCode: 403,
        message: expect.stringMatching(
          /^Creator "Mayor 1" is banned for the following reason: uploading inappropriate/u
        ),
        error: 'BannedCreatorError'
      });
    });

    test(`rejects a banned IP, read from the proxy's X-Forwarded-For`, async () => {
      const creator = await createCreator(testApp.prisma);

      await createBan(testApp.prisma, { ip: identifiers.ip1 });

      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/me',
        headers: { ...modHeaders(creator), 'x-forwarded-for': identifiers.ip1 }
      });

      expect(response.statusCode).toBe(403);

      expect(response.json<unknown>()).toEqual({
        statusCode: 403,
        message: expect.stringMatching(/^You are banned for the following reason: /u),
        error: 'BannedError'
      });
    });

    test(`rejects a banned hardware ID`, async () => {
      const creator = await createCreator(testApp.prisma);

      await createBan(testApp.prisma, { hwid: nn(creator.hwids[0]) });

      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/creators/me',
        headers: modHeaders(creator)
      });

      expect(response.statusCode).toBe(403);

      expect(response.json<unknown>()).toEqual({
        statusCode: 403,
        message: expect.stringMatching(/^You are banned for the following reason: /u),
        error: 'BannedError'
      });
    });
  });
});
