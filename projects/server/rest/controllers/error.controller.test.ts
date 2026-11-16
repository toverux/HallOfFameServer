import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import path from 'node:path';
import process from 'node:process';
import * as Bun from 'bun';
import type { Creator } from '#prisma-lib/client';
import { nn } from '../../../shared/utils/type-assertion';
import { ModErrorReportService } from '../../services';
import { createCreator } from '../../testing/factories';
import { FakeSentryIngest } from '../../testing/fake-sentry-ingest';
import { fetchStub } from '../../testing/fetch-stub';
import * as identifiers from '../../testing/identifiers';
import { createTestApp, modHeaders, type TestApp } from '../../testing/test-app';

const fixtures = path.join(import.meta.dir, '../../testing/mod-error-fixtures');

const monoStack = await Bun.file(path.join(fixtures, 'mono-exception-after-await.txt')).text();

const neverThrownStack = await Bun.file(path.join(fixtures, 'exception-never-thrown.txt')).text();

const cohtmlStack = await Bun.file(path.join(fixtures, 'cohtml-error-stack.txt')).text();

const unityStack = await Bun.file(path.join(fixtures, 'unity-log-escaped-exception.txt')).text();

const probeSource = '/home/user/Documents/Dev/HallOfFame/HallOfFame/Probe.cs';

const context = {
  modVersion: '1.9.0',
  gameVersion: '1.6.4f1',
  debug: false,
  platform: 'Windows 11  (10.0.26100) 64bit',
  wine: true,
  screenWidth: 2560,
  screenHeight: 1440,
  gpuName: 'NVIDIA GeForce RTX 4070',
  gpuVendor: 'NVIDIA',
  gpuDriverVersion: '32.0.15.6094',
  locale: 'fr-FR'
};

/**
 * A report as the mod posts it for an exception it logged.
 */
const report = {
  source: 'log',
  severity: 'recoverable',
  type: 'System.InvalidOperationException',
  message: `Probe: thrown after an await.`,
  stack: monoStack,
  context
};

describe('ErrorController', () => {
  let testApp: TestApp;

  let sentry: FakeSentryIngest;

  let creator: Creator;

  beforeEach(async () => {
    process.env.HOF_SENTRY_MOD_DSN = FakeSentryIngest.dsn;

    sentry = new FakeSentryIngest();
    sentry.install();

    testApp = await createTestApp();

    creator = await createCreator(testApp.prisma);
  });

  afterEach(async () => {
    process.env.HOF_SENTRY_MOD_DSN = 'disabled';

    setSystemTime();

    await testApp.app.close();
  });

  describe('POST /api/v1/errors', () => {
    test(`passes a C# report to Sentry with Mono's frames, inner exception included`, async () => {
      const response = await post(modHeaders(creator), report, identifiers.sessionId1);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');

      expect(sentry.events).toHaveLength(1);

      expect(nn(sentry.events[0])).toMatchObject({
        level: 'error',
        platform: 'csharp',
        release: 'HallOfFame@1.9.0',
        environment: 'test',
        tags: {
          source: 'log',
          severity: 'recoverable',
          session_id: identifiers.sessionId1,
          game_version: '1.6.4f1',
          debug: 'false',
          platform: 'Windows 11  (10.0.26100) 64bit',
          wine: 'true',
          gpu_vendor: 'NVIDIA',
          locale: 'fr-FR'
        },
        contexts: {
          gpu: {
            name: 'NVIDIA GeForce RTX 4070',
            vendor_name: 'NVIDIA',
            driver_version: '32.0.15.6094'
          },
          device: { screen_width_pixels: 2560, screen_height_pixels: 1440 },
          os: { name: 'Windows 11  (10.0.26100) 64bit' },
          runtime: { name: 'Mono' }
        }
      });

      // Innermost first, each with its frames oldest first, as Sentry reads them.
      expect(nn(sentry.events[0]).exception).toEqual({
        values: [
          {
            type: 'System.InvalidOperationException',
            value: `Probe: the inner cause.`,
            stacktrace: {
              frames: [probeFrame('ThrowAfterAwait', 85), probeFrame('InnerThrower', 66)]
            }
          },
          {
            type: 'System.InvalidOperationException',
            value: `Probe: thrown after an await.`,
            stacktrace: {
              frames: [probeFrame('AwaitProbe', 72), probeFrame('ThrowAfterAwait', 88)]
            }
          }
        ]
      });

      expect(nn(sentry.events[0]).extra).toBeUndefined();
    });

    test(`reports as the Creator's public ID alone, with no IP, name, or Creator ID`, async () => {
      const response = await post(modHeaders(creator), report);

      expect(response.statusCode).toBe(204);

      expect(nn(sentry.events[0]).user).toEqual({ id: creator.id });

      // Sentry infers no IP from the server's connection either.
      expect(nn(sentry.events[0]).sdk?.settings).toEqual({ infer_ip: 'never' });

      const envelope = nn(sentry.envelopes[0]);

      expect(envelope).not.toContain(nn(creator.ips[0]));
      expect(envelope).not.toContain(nn(creator.creatorName));
      expect(envelope).not.toContain(creator.creatorId);
    });

    test(`passes a never-thrown exception, which has no frame, through Mono's parser`, async () => {
      const response = await post(modHeaders(creator), {
        ...report,
        severity: 'fatal',
        type: 'System.Exception',
        message: `Failed to find field m_Count in ScreenUtility.`,
        stack: neverThrownStack
      });

      expect(response.statusCode).toBe(204);

      expect(nn(sentry.events[0])).toMatchObject({ level: 'fatal', tags: { severity: 'fatal' } });

      expect(nn(sentry.events[0]).exception).toEqual({
        values: [
          { type: 'System.Exception', value: `Failed to find field m_Count in ScreenUtility.` }
        ]
      });

      expect(nn(sentry.events[0]).extra).toBeUndefined();
    });

    test(`passes a UI report to Sentry with cohtml's frames`, async () => {
      const response = await post(modHeaders(creator), {
        source: 'ui',
        stack: cohtmlStack,
        context
      });

      expect(response.statusCode).toBe(204);

      expect(nn(sentry.events[0])).toMatchObject({
        level: 'error',
        platform: 'javascript',
        tags: { source: 'ui' }
      });

      expect(nn(sentry.events[0]).tags).not.toHaveProperty('severity');

      const bundle = 'coui://ui-mods/HallOfFame.mjs';

      expect(nn(sentry.events[0]).exception).toEqual({
        values: [
          {
            type: 'TypeError',
            value: `Probe: thrown in the UI bundle at 1794814312482.`,
            stacktrace: {
              frames: [
                {
                  function: '?',
                  filename: bundle,
                  abs_path: bundle,
                  lineno: 15,
                  colno: 33_420,
                  in_app: true
                },
                {
                  function: 'J2',
                  filename: bundle,
                  abs_path: bundle,
                  lineno: 15,
                  colno: 33_287,
                  in_app: true
                },
                {
                  function: 'J2',
                  filename: bundle,
                  abs_path: bundle,
                  lineno: 15,
                  colno: 33_287,
                  in_app: true
                },
                {
                  function: 'J2',
                  filename: bundle,
                  abs_path: bundle,
                  lineno: 15,
                  colno: 33_308,
                  in_app: true
                }
              ]
            }
          }
        ]
      });
    });

    test(`passes a stack no parser reads on raw, beside the report's exception`, async () => {
      const response = await post(modHeaders(creator), {
        source: 'escaped',
        type: 'System.InvalidOperationException',
        message: `Probe: thrown from an async void trigger handler.`,
        stack: unityStack,
        context
      });

      expect(response.statusCode).toBe(204);

      expect(nn(sentry.events[0])).toMatchObject({
        platform: 'csharp',
        tags: { source: 'escaped' },
        exception: {
          values: [
            {
              type: 'System.InvalidOperationException',
              value: `Probe: thrown from an async void trigger handler.`
            }
          ]
        },
        extra: { stack: unityStack }
      });

      expect(nn(sentry.events[0]).exception?.values?.[0]).not.toHaveProperty('stacktrace');
    });

    test(`names a raw stack's exception from its first line when the report has none`, async () => {
      const response = await post(modHeaders(creator), {
        source: 'escaped',
        stack: unityStack,
        context
      });

      expect(response.statusCode).toBe(204);

      expect(nn(sentry.events[0]).exception).toEqual({
        values: [
          {
            type: 'InvalidOperationException',
            value: `Probe: thrown from an async void trigger handler.`
          }
        ]
      });
    });

    test(`accepts a report with no session header, and tags no session`, async () => {
      const response = await post(modHeaders(creator), report);

      expect(response.statusCode).toBe(204);

      expect(nn(sentry.events[0]).tags).not.toHaveProperty('session_id');
    });

    test(`ignores a session header that is not a UUID`, async () => {
      const response = await post(modHeaders(creator), report, 'not-a-uuid');

      expect(response.statusCode).toBe(204);

      expect(nn(sentry.events[0]).tags).not.toHaveProperty('session_id');
    });

    test(`leaves out of the event the context fields the mod could not read`, async () => {
      const response = await post(modHeaders(creator), {
        ...report,
        context: { modVersion: '1.9.0', gameVersion: '1.6.4f1', debug: true }
      });

      expect(response.statusCode).toBe(204);

      expect(nn(sentry.events[0]).tags).toEqual({
        source: 'log',
        severity: 'recoverable',
        game_version: '1.6.4f1',
        debug: 'true'
      });

      expect(nn(sentry.events[0]).contexts).not.toContainAnyKeys(['gpu', 'device', 'os']);
    });

    test(`accepts a report and drops it with no DSN`, async () => {
      await testApp.app.close();

      process.env.HOF_SENTRY_MOD_DSN = 'disabled';

      testApp = await createTestApp();

      const response = await post(modHeaders(creator), report);

      expect(response.statusCode).toBe(204);

      expect(fetchStub.requests).toEqual([]);
    });

    test(`passes the hourly cap of reports, all players together, and drops the rest`, async () => {
      setSystemTime(new Date('2026-11-16T10:00:00Z'));

      const creators = [creator, await createCreator(testApp.prisma)];

      for (let i = 0; i < ModErrorReportService.maxReportsPerHour; i++) {
        // oxlint-disable-next-line no-await-in-loop - the cap counts reports in order
        const response = await post(modHeaders(nn(creators[i % creators.length])), report);

        expect(response.statusCode).toBe(204);
      }

      setSystemTime(new Date('2026-11-16T10:59:59Z'));

      const overCap = await post(modHeaders(creator), report);

      expect(overCap.statusCode).toBe(204);

      expect(sentry.events).toHaveLength(ModErrorReportService.maxReportsPerHour);

      setSystemTime(new Date('2026-11-16T11:00:00Z'));

      const nextHour = await post(modHeaders(creator), report);

      expect(nextHour.statusCode).toBe(204);

      expect(sentry.events).toHaveLength(ModErrorReportService.maxReportsPerHour + 1);
    });

    test(`removes its Sentry client's exit listeners when the app closes`, async () => {
      const listenerCount = process.listenerCount('beforeExit');

      const otherApp = await createTestApp();

      expect(process.listenerCount('beforeExit')).toBeGreaterThan(listenerCount);

      await otherApp.app.close();

      expect(process.listenerCount('beforeExit')).toBe(listenerCount);
    });

    test(`returns 401 without credentials, and reports nothing`, async () => {
      const response = await post({}, report);

      expect(response.statusCode).toBe(401);

      expect(response.json<unknown>()).toEqual({
        statusCode: 401,
        message: `Request not authenticated.`,
        error: 'UnauthorizedError'
      });

      expect(fetchStub.requests).toEqual([]);
    });

    test.each([
      ['an unknown field', { ...report, playset: [] }],
      ['an unknown source', { ...report, source: 'game' }],
      ['an unknown severity', { ...report, severity: 'warning' }],
      ['no stack', { ...report, stack: undefined }],
      ['an empty stack', { ...report, stack: '' }],
      ['an over-long stack', { ...report, stack: 'a'.repeat(16_385) }],
      ['an over-long message', { ...report, message: 'a'.repeat(4097) }],
      ['an over-long type', { ...report, type: 'a'.repeat(257) }],
      ['no context', { ...report, context: undefined }],
      ['an unknown context field', { ...report, context: { ...context, hwid: identifiers.hwid1 } }],
      [
        'a context without a mod version',
        { ...report, context: { ...context, modVersion: undefined } }
      ],
      [
        'an over-long mod version',
        { ...report, context: { ...context, modVersion: '1'.repeat(33) } }
      ],
      ['an over-long GPU name', { ...report, context: { ...context, gpuName: 'a'.repeat(129) } }],
      ['an over-long locale', { ...report, context: { ...context, locale: 'a'.repeat(17) } }],
      ['a fractional screen width', { ...report, context: { ...context, screenWidth: 1.5 } }],
      ['an oversized screen height', { ...report, context: { ...context, screenHeight: 32_769 } }],
      ['a Wine flag that is not a boolean', { ...report, context: { ...context, wine: 'yes' } }]
    ] as const)(`returns 400 for a report with %s, and reports nothing`, async (_case, body) => {
      const response = await post(modHeaders(creator), body);

      expect(response.statusCode).toBe(400);
      expect(response.json<unknown>()).toEqual({
        statusCode: 400,
        message: `Invalid body`,
        validation: expect.any(Object)
      });

      expect(fetchStub.requests).toEqual([]);
    });

    test(`accepts each field at its bound`, async () => {
      const response = await post(modHeaders(creator), {
        ...report,
        type: 'a'.repeat(256),
        message: 'a'.repeat(4096),
        stack: 'a'.repeat(16_384),
        context: {
          ...context,
          modVersion: '1'.repeat(32),
          gameVersion: '1'.repeat(32),
          platform: 'a'.repeat(128),
          gpuName: 'a'.repeat(128),
          gpuVendor: 'a'.repeat(128),
          gpuDriverVersion: 'a'.repeat(128),
          locale: 'a'.repeat(16),
          screenWidth: 32_768,
          screenHeight: 32_768
        }
      });

      expect(response.statusCode).toBe(204);

      expect(sentry.events).toHaveLength(1);
    });
  });

  function post(
    headers: Readonly<Record<string, string>>,
    body: object,
    sessionId?: string
  ): ReturnType<TestApp['app']['inject']> {
    return testApp.app.inject({
      method: 'POST',
      url: '/api/v1/errors',
      headers: sessionId ? { ...headers, 'x-session-id': sessionId } : headers,
      payload: body
    });
  }
});

function probeFrame(fn: string, lineno: number): object {
  return {
    function: fn,
    module: 'HallOfFame.Probe',
    filename: probeSource,
    abs_path: probeSource,
    lineno,
    in_app: true
  };
}
