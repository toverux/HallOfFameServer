import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { createCreator } from '../../testing/factories';
import * as identifiers from '../../testing/identifiers';
import { createTestApp, modHeaders, type TestApp } from '../../testing/test-app';

const event = { name: 'capture_requested', properties: {}, at: '2026-10-28T09:59:59.500Z' };

/**
 * A batch as the mod posts it: the session and versions once, then the events.
 */
const batch = {
  sessionId: identifiers.sessionId1,
  modVersion: '1.9.0',
  gameVersion: '1.6.2f1',
  debug: false,
  events: [
    {
      name: 'slideshow_navigated',
      properties: { direction: 'next', via: 'action', device: 'gamepad' },
      at: '2026-10-28T09:59:58.250Z'
    },
    event,
    { name: 'tour_finished', properties: { completed: true, step: 4 }, at: '2026-10-28T10:00:00Z' }
  ]
};

describe('UsageController', () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp.app.close();
  });

  describe('POST /api/v1/usage/events', () => {
    afterEach(() => {
      setSystemTime();
    });

    test(`stores each event of the batch with the creator and the envelope`, async () => {
      setSystemTime(new Date('2026-10-28T10:00:05Z'));

      const creator = await createCreator(testApp.prisma);

      const response = await post(modHeaders(creator), batch);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');

      const envelope = {
        id: expect.any(String),
        creatorId: creator.id,
        sessionId: identifiers.sessionId1,
        modVersion: '1.9.0',
        gameVersion: '1.6.2f1',
        isDebug: false,
        receivedAt: new Date('2026-10-28T10:00:05Z')
      };

      expect(await testApp.prisma.usageEvent.findMany({ orderBy: { trackedAt: 'asc' } })).toEqual([
        {
          ...envelope,
          name: 'slideshow_navigated',
          properties: { direction: 'next', via: 'action', device: 'gamepad' },
          trackedAt: new Date('2026-10-28T09:59:58.250Z')
        },
        {
          ...envelope,
          name: 'capture_requested',
          properties: {},
          trackedAt: new Date('2026-10-28T09:59:59.500Z')
        },
        {
          ...envelope,
          name: 'tour_finished',
          properties: { completed: true, step: 4 },
          trackedAt: new Date('2026-10-28T10:00:00Z')
        }
      ]);
    });

    test(`stores the debug flag of a debug build`, async () => {
      const creator = await createCreator(testApp.prisma);

      const response = await post(modHeaders(creator), { ...batch, debug: true });

      expect(response.statusCode).toBe(204);

      expect(await testApp.prisma.usageEvent.findMany({ select: { isDebug: true } })).toEqual([
        { isDebug: true },
        { isDebug: true },
        { isDebug: true }
      ]);
    });

    test(`returns 401 without credentials`, async () => {
      const response = await post({}, batch);

      expect(response.statusCode).toBe(401);

      expect(response.json<unknown>()).toEqual({
        statusCode: 401,
        message: `Request not authenticated.`,
        error: 'UnauthorizedError'
      });

      expect(await testApp.prisma.usageEvent.count()).toBe(0);
    });

    test.each([
      ['an unknown envelope field', { ...batch, locale: 'fr-FR' }],
      ['a missing envelope field', { ...batch, gameVersion: undefined }],
      ['a session ID that is not a UUID', { ...batch, sessionId: 'not-a-uuid' }],
      ['an over-long mod version', { ...batch, modVersion: '1'.repeat(33) }],
      ['no event', { ...batch, events: [] }],
      ['an unknown event field', { ...batch, events: [{ ...event, extra: 1 }] }],
      ['an empty event name', { ...batch, events: [{ ...event, name: '' }] }],
      ['an over-long event name', { ...batch, events: [{ ...event, name: 'a'.repeat(65) }] }],
      ['a timestamp that is not a date', { ...batch, events: [{ ...event, at: 'yesterday' }] }],
      ['nested properties', { ...batch, events: [{ ...event, properties: { a: { b: 1 } } }] }],
      ['a null property', { ...batch, events: [{ ...event, properties: { a: null } }] }],
      [
        'an over-long property string',
        { ...batch, events: [{ ...event, properties: { a: 'a'.repeat(257) } }] }
      ],
      [
        'an over-long property key',
        { ...batch, events: [{ ...event, properties: { ['a'.repeat(65)]: 1 } }] }
      ],
      [
        'an Extended JSON property key',
        {
          ...batch,
          events: [{ ...event, properties: { $oid: '507f1f77bcf86cd799439011' } }]
        }
      ],
      ['a dotted property key', { ...batch, events: [{ ...event, properties: { 'a.b': 1 } }] }],
      ['an empty property key', { ...batch, events: [{ ...event, properties: { '': 1 } }] }],
      [
        'too many properties',
        {
          ...batch,
          events: [
            {
              ...event,
              properties: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, i]))
            }
          ]
        }
      ]
    ] as const)(`returns 400 for a batch with %s, and stores none of it`, async (_case, body) => {
      const creator = await createCreator(testApp.prisma);

      const response = await post(modHeaders(creator), body);

      expect(response.statusCode).toBe(400);
      expect(response.json<unknown>()).toEqual({
        statusCode: 400,
        message: `Invalid body`,
        validation: expect.any(Object)
      });

      expect(await testApp.prisma.usageEvent.count()).toBe(0);
    });

    test(`stores a batch of 100 events`, async () => {
      const creator = await createCreator(testApp.prisma);

      const response = await post(modHeaders(creator), {
        ...batch,
        events: Array.from({ length: 100 }, () => event)
      });

      expect(response.statusCode).toBe(204);

      expect(await testApp.prisma.usageEvent.count()).toBe(100);
    });

    test(`returns 400 for a batch of 101 events, and stores none of it`, async () => {
      const creator = await createCreator(testApp.prisma);

      const response = await post(modHeaders(creator), {
        ...batch,
        events: Array.from({ length: 101 }, () => event)
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<unknown>()).toEqual({
        statusCode: 400,
        message: `Invalid body`,
        validation: expect.any(Object)
      });

      expect(await testApp.prisma.usageEvent.count()).toBe(0);
    });
  });

  test(`expires usage events a year after receipt, by an index created at boot`, async () => {
    // As a schema push leaves the collection: it drops every index the schema does not declare.
    await testApp.prisma.$runCommandRaw({ dropIndexes: 'usage_events', index: { receivedAt: 1 } });

    await testApp.app.close();

    testApp = await createTestApp();

    expect(await listTtlIndexes()).toEqual([
      { key: { receivedAt: 1 }, expireAfterSeconds: 365 * 24 * 60 * 60 }
    ]);
  });

  test(`changes the expiry of an index left with another one, at boot`, async () => {
    // As an image built with another retention leaves it, which a restart or a rollback then boots
    // on without a schema push.
    await testApp.prisma.$runCommandRaw({
      collMod: 'usage_events',
      index: { name: 'receivedAt_ttl', expireAfterSeconds: 1000 }
    });

    await testApp.app.close();

    testApp = await createTestApp();

    expect(await listTtlIndexes()).toEqual([
      { key: { receivedAt: 1 }, expireAfterSeconds: 365 * 24 * 60 * 60 }
    ]);
  });

  async function listTtlIndexes(): Promise<unknown> {
    // The raw command's result is untyped JSON.
    const { cursor } = (await testApp.prisma.$runCommandRaw({
      listIndexes: 'usage_events'
    })) as unknown as {
      cursor: { firstBatch: ReadonlyArray<{ key: unknown; expireAfterSeconds?: number }> };
    };

    return cursor.firstBatch
      .filter(index => index.expireAfterSeconds != null)
      .map(({ key, expireAfterSeconds }) => ({ key, expireAfterSeconds }));
  }

  function post(
    headers: Readonly<Record<string, string>>,
    body: object
  ): ReturnType<TestApp['app']['inject']> {
    return testApp.app.inject({
      method: 'POST',
      url: '/api/v1/usage/events',
      headers,
      payload: body
    });
  }
});
