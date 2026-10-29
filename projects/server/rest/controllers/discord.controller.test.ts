import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import process from 'node:process';
import { Logger } from '@nestjs/common';
import * as sentry from '@sentry/bun';
import type { Creator, ModerationCase, Screenshot } from '#prisma-lib/client';
import { nn } from '../../../shared/utils/type-assertion';
import { config } from '../../config';
import { ModerationCaseService, ScreenshotService } from '../../services';
import {
  buttonClickInteraction,
  discordInteractionRequest
} from '../../testing/discord-interactions';
import {
  createCreator,
  createFavorite,
  createModerationCase,
  createScreenshot
} from '../../testing/factories';
import { FakeDiscordApi } from '../../testing/fake-discord-api';
import * as identifiers from '../../testing/identifiers';
import { createTestApp, type TestApp } from '../../testing/test-app';

const moderatorId = nn(config.discord.moderatorIds[0]);

const ephemeralFlag = 64;

const deferredUpdate = { type: 6 };

const alreadyHandled = {
  type: 4,
  data: { content: `This case was already handled.`, flags: ephemeralFlag }
};

describe('DiscordController', () => {
  let testApp: TestApp;

  let discord: FakeDiscordApi;

  let creator: Creator;

  let screenshot: Screenshot;

  beforeEach(async () => {
    testApp = await createTestApp();

    discord = new FakeDiscordApi().install();

    creator = await createCreator(testApp.prisma, {
      ips: [identifiers.ip1],
      hwids: [identifiers.hwid1]
    });

    const reporter = await createCreator(testApp.prisma);

    screenshot = await createScreenshot(testApp.prisma, creator, {
      isReported: true,
      reportedById: reporter.id
    });
  });

  afterEach(async () => {
    await testApp.app.close();
  });

  function findCase(moderationCase: Pick<ModerationCase, 'id'>): Promise<ModerationCase> {
    return testApp.prisma.moderationCase.findUniqueOrThrow({ where: { id: moderationCase.id } });
  }

  /**
   * Opens a report case on the screenshot and posts it, as the daily batch does.
   */
  async function postReportCase(): Promise<ModerationCase> {
    const moderationCase = await createModerationCase(testApp.prisma, screenshot);

    await testApp.app.get(ModerationCaseService).postPendingCases();

    return findCase(moderationCase);
  }

  /**
   * Opens a showcase case on a screenshot showcasing mod 74604 and posts it, as the daily batch
   * does.
   */
  async function postShowcaseCase(): Promise<{
    showcasing: Screenshot;
    moderationCase: ModerationCase;
  }> {
    const showcasing = await createScreenshot(testApp.prisma, creator, { showcasedModId: 74_604 });

    const { id } = await createModerationCase(testApp.prisma, showcasing, {
      kind: 'showcased_mod',
      showcasedModId: 74_604
    });

    await testApp.app.get(ModerationCaseService).postPendingCases();

    return { showcasing, moderationCase: await findCase({ id }) };
  }

  /**
   * Opens a near-duplicate case on two screenshots of the creator, unposted.
   */
  async function openPairCase(): Promise<{
    older: Screenshot;
    newer: Screenshot;
    moderationCase: ModerationCase;
  }> {
    const older = await createScreenshot(testApp.prisma, creator, {
      createdAt: new Date('2026-10-01T10:00:00Z')
    });

    const newer = await createScreenshot(testApp.prisma, creator, {
      createdAt: new Date('2026-10-02T10:00:00Z')
    });

    const moderationCase = await createModerationCase(testApp.prisma, newer, {
      kind: 'near_duplicate',
      pairedScreenshotId: older.id,
      pairDistance: 0.08
    });

    return { older, newer, moderationCase };
  }

  async function click(
    customId: string,
    options?: Parameters<typeof buttonClickInteraction>[1]
  ): Promise<{ statusCode: number; body: unknown }> {
    const response = await testApp.app.inject(
      await discordInteractionRequest(buttonClickInteraction(customId, options))
    );

    return { statusCode: response.statusCode, body: response.json() };
  }

  describe('POST /api/v1/discord/interactions', () => {
    test(`answers a PING with a PONG`, async () => {
      const response = await testApp.app.inject(await discordInteractionRequest({ type: 1 }));

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ type: 1 });
    });

    test.each([
      [
        'a body altered after signing',
        async () => ({ ...(await discordInteractionRequest({ type: 1 })), payload: '{"type":1} ' })
      ],
      [
        'an unsigned request',
        async () => {
          const request = await discordInteractionRequest({ type: 1 });

          return { ...request, headers: { 'content-type': 'application/json' } };
        }
      ]
    ])(`rejects %s with a 401`, async (_name, buildRequest) => {
      const response = await testApp.app.inject(await buildRequest());

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        statusCode: 401,
        message: `Invalid request signature.`,
        error: 'UnauthorizedError'
      });
    });

    test(`answers 404 while Discord is disabled`, async () => {
      const botToken = process.env.HOF_DISCORD_BOT_TOKEN;

      process.env.HOF_DISCORD_BOT_TOKEN = 'disabled';

      try {
        const response = await testApp.app.inject(await discordInteractionRequest({ type: 1 }));

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          statusCode: 404,
          message: `Discord is disabled.`,
          error: 'Not Found'
        });
      } finally {
        process.env.HOF_DISCORD_BOT_TOKEN = botToken;
      }
    });

    test(`answers 503 in maintenance mode, like the rest of the API`, async () => {
      const { maintenanceMessage } = config.http;

      // The request logger reports a 503 as an error.
      const logError = spyOn(Logger.prototype, 'error').mockReturnValue(undefined);

      Reflect.set(config.http, 'maintenanceMessage', 'true');

      try {
        const response = await testApp.app.inject(await discordInteractionRequest({ type: 1 }));

        expect(response.statusCode).toBe(503);
      } finally {
        Reflect.set(config.http, 'maintenanceMessage', maintenanceMessage);

        logError.mockRestore();
      }
    });

    test(`tells a user off the moderator list they are not allowed`, async () => {
      const moderationCase = await postReportCase();

      expect(
        await click(`approve:${moderationCase.id}`, { userId: '1100000000000000099' })
      ).toEqual({
        statusCode: 200,
        body: {
          type: 4,
          data: { content: `You are not allowed to moderate Hall of Fame.`, flags: ephemeralFlag }
        }
      });

      await testApp.backgroundTasks.settled();

      expect(await findCase(moderationCase)).toEqual(moderationCase);
      expect(discord.messages).toHaveLength(1);
    });

    test(`approves at once: settles the case through Discord and deletes its message`, async () => {
      const moderationCase = await postReportCase();

      expect(await click(`approve:${moderationCase.id}`)).toEqual({
        statusCode: 200,
        body: deferredUpdate
      });

      await testApp.backgroundTasks.settled();

      expect(
        await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: screenshot.id } })
      ).toMatchObject({ isApproved: true, isReported: false, reportedById: null });

      expect(await findCase(moderationCase)).toMatchObject({
        outcome: 'approved',
        settledThrough: 'discord',
        settledByDiscordUserId: moderatorId,
        settleClaimedAt: null
      });

      expect(discord.messages).toEqual([]);
      expect(discord.deletedMessageIds).toEqual([nn(moderationCase.discordMessageId)]);
    });

    test(`deletes at once, deleting the case's message`, async () => {
      const moderationCase = await postReportCase();

      expect(await click(`delete:${moderationCase.id}`)).toEqual({
        statusCode: 200,
        body: deferredUpdate
      });

      await testApp.backgroundTasks.settled();

      expect(await testApp.prisma.screenshot.count({ where: { id: screenshot.id } })).toBe(0);
      expect(await testApp.prisma.ban.count()).toBe(0);

      expect(await findCase(moderationCase)).toMatchObject({
        outcome: 'deleted',
        settledThrough: 'discord',
        settledByDiscordUserId: moderatorId
      });

      expect(discord.messages).toEqual([]);
    });

    test(`bans the creator and deletes at once`, async () => {
      const moderationCase = await postReportCase();

      expect(await click(`ban:${moderationCase.id}`)).toEqual({
        statusCode: 200,
        body: deferredUpdate
      });

      await testApp.backgroundTasks.settled();

      expect(await testApp.prisma.screenshot.count({ where: { id: screenshot.id } })).toBe(0);

      expect(await testApp.prisma.ban.findMany({ select: { creatorId: true } })).toContainEqual({
        creatorId: creator.id
      });

      expect(await findCase(moderationCase)).toMatchObject({
        outcome: 'banned',
        settledThrough: 'discord',
        settledByDiscordUserId: moderatorId
      });

      expect(discord.messages).toEqual([]);
    });

    test.each([
      { action: 'accept', outcome: 'accepted', showcasedModId: 74_604, isValidated: true },
      { action: 'remove', outcome: 'removed', showcasedModId: null, isValidated: false }
    ] as const)(
      `settles a showcase at once with $action, deleting its message`,
      async ({ action, outcome, showcasedModId, isValidated }) => {
        const { showcasing, moderationCase } = await postShowcaseCase();

        expect(await click(`${action}:${moderationCase.id}`)).toEqual({
          statusCode: 200,
          body: deferredUpdate
        });

        await testApp.backgroundTasks.settled();

        expect(
          await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: showcasing.id } })
        ).toMatchObject({ showcasedModId, isShowcasedModValidated: isValidated });

        expect(await findCase(moderationCase)).toMatchObject({
          outcome,
          settledThrough: 'discord',
          settledByDiscordUserId: moderatorId
        });

        expect(discord.messages).toEqual([]);
        expect(discord.deletedMessageIds).toEqual([nn(moderationCase.discordMessageId)]);
      }
    );

    test(`settles as moot a showcase whose screenshot showcases another mod since`, async () => {
      const { showcasing, moderationCase } = await postShowcaseCase();

      // As a moot settle that failed after the edit.
      await testApp.prisma.screenshot.update({
        where: { id: showcasing.id },
        data: { showcasedModId: 87_755 }
      });

      expect(await click(`accept:${moderationCase.id}`)).toEqual({
        statusCode: 200,
        body: {
          type: 4,
          data: {
            content: `This screenshot no longer showcases this mod, the case is closed.`,
            flags: ephemeralFlag
          }
        }
      });

      await testApp.backgroundTasks.settled();

      expect(
        await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: showcasing.id } })
      ).toMatchObject({ showcasedModId: 87_755, isShowcasedModValidated: false });

      expect(await findCase(moderationCase)).toMatchObject({ outcome: 'moot' });
      expect(discord.messages).toEqual([]);
    });

    test(`allows both screenshots of a pair at once, deleting its message`, async () => {
      const { older, newer, moderationCase } = await openPairCase();

      await testApp.app.get(ModerationCaseService).postPendingCases();

      const { discordMessageId } = await findCase(moderationCase);

      expect(await click(`allow:${moderationCase.id}`)).toEqual({
        statusCode: 200,
        body: deferredUpdate
      });

      await testApp.backgroundTasks.settled();

      expect(testApp.screenshotSimilarityDetector.allowedSimilarities).toEqual([
        [older.id, newer.id]
      ]);

      expect(
        await testApp.prisma.screenshot.count({ where: { id: { in: [older.id, newer.id] } } })
      ).toBe(2);

      expect(await findCase(moderationCase)).toMatchObject({
        outcome: 'allowed',
        settledThrough: 'discord',
        settledByDiscordUserId: moderatorId
      });

      expect(discord.messages).toEqual([]);
      expect(discord.deletedMessageIds).toEqual([nn(discordMessageId)]);
    });

    test.each([
      { action: 'keepA', outcome: 'kept_a', keptRole: 'older', mergedRole: 'newer' },
      { action: 'keepB', outcome: 'kept_b', keptRole: 'newer', mergedRole: 'older' }
    ] as const)(
      `$action merges the other screenshot into the kept one, mooting the other cases naming it`,
      async ({ action, outcome, keptRole, mergedRole }) => {
        const pair = await openPairCase();

        const { moderationCase, [keptRole]: kept, [mergedRole]: merged } = pair;

        const liker = await createCreator(testApp.prisma, {
          ips: [identifiers.ip2],
          hwids: [identifiers.hwid2]
        });

        await createFavorite(testApp.prisma, merged, liker);

        const latest = await createScreenshot(testApp.prisma, creator, {
          createdAt: new Date('2026-10-03T10:00:00Z')
        });

        const otherCase = await createModerationCase(testApp.prisma, latest, {
          kind: 'near_duplicate',
          pairedScreenshotId: merged.id,
          pairDistance: 0.1
        });

        await testApp.app.get(ModerationCaseService).postPendingCases();

        expect(await click(`${action}:${moderationCase.id}`)).toEqual({
          statusCode: 200,
          body: deferredUpdate
        });

        await testApp.backgroundTasks.settled();

        expect(await testApp.prisma.screenshot.count({ where: { id: merged.id } })).toBe(0);

        expect(await testApp.prisma.favorite.findMany({ select: { screenshotId: true } })).toEqual([
          { screenshotId: kept.id }
        ]);

        expect(await findCase(moderationCase)).toMatchObject({
          outcome,
          settledThrough: 'discord',
          settledByDiscordUserId: moderatorId
        });

        expect(await findCase(otherCase)).toMatchObject({ outcome: 'moot' });

        expect(discord.messages).toEqual([]);
        expect(discord.deletedMessageIds).toHaveLength(2);
      }
    );

    test(`settles as moot a pair one of whose screenshots left`, async () => {
      const { older, moderationCase } = await openPairCase();

      await testApp.app.get(ModerationCaseService).postPendingCases();

      // As an account deletion does, bypassing the screenshot service.
      await testApp.prisma.screenshot.delete({ where: { id: older.id } });

      expect(await click(`keepB:${moderationCase.id}`)).toEqual({
        statusCode: 200,
        body: {
          type: 4,
          data: {
            content: `A screenshot of this pair no longer exists, the case is closed.`,
            flags: ephemeralFlag
          }
        }
      });

      await testApp.backgroundTasks.settled();

      expect(await findCase(moderationCase)).toMatchObject({ outcome: 'moot' });
      expect(discord.messages).toEqual([]);
    });

    test(`matches no case for an action of another kind`, async () => {
      const moderationCase = await postReportCase();

      expect(await click(`accept:${moderationCase.id}`)).toEqual({
        statusCode: 200,
        body: {
          type: 4,
          data: { content: `This button matches no moderation case.`, flags: ephemeralFlag }
        }
      });

      expect(await findCase(moderationCase)).toEqual(moderationCase);
    });

    test(`answers "already handled" for a settled case, deleting a message left`, async () => {
      const moderationCase = await postReportCase();

      // As after a failed delete of the message.
      await testApp.prisma.moderationCase.update({
        where: { id: moderationCase.id },
        data: { outcome: 'approved', settledThrough: 'cli', settledAt: new Date() }
      });

      expect(await click(`delete:${moderationCase.id}`)).toEqual({
        statusCode: 200,
        body: alreadyHandled
      });

      await testApp.backgroundTasks.settled();

      expect(await testApp.prisma.screenshot.count()).toBe(1);
      expect(discord.messages).toEqual([]);
    });

    test(`settles once for two concurrent clicks, the loser "already handled"`, async () => {
      const moderationCase = await postReportCase();

      const unmarkReported = spyOn(testApp.app.get(ScreenshotService), 'unmarkReported');

      const responses = await Promise.all([
        click(`approve:${moderationCase.id}`),
        click(`approve:${moderationCase.id}`)
      ]);

      await testApp.backgroundTasks.settled();

      expect(responses.map(response => response.body)).toContainEqual(deferredUpdate);
      expect(responses.map(response => response.body)).toContainEqual(alreadyHandled);

      expect(unmarkReported).toHaveBeenCalledTimes(1);

      expect(await findCase(moderationCase)).toMatchObject({ outcome: 'approved' });
    });

    test(`keeps the message of a failed action and tells why, so a retry succeeds`, async () => {
      const logError = spyOn(Logger.prototype, 'error').mockReturnValue(undefined);
      const captureException = spyOn(sentry, 'captureException').mockReturnValue('');

      try {
        const moderationCase = await postReportCase();

        spyOn(testApp.app.get(ScreenshotService), 'unmarkReported').mockRejectedValueOnce(
          new Error(`Database unavailable.`)
        );

        expect(
          await click(`approve:${moderationCase.id}`, { interactionToken: 'first-click' })
        ).toEqual({ statusCode: 200, body: deferredUpdate });

        await testApp.backgroundTasks.settled();

        expect(discord.followups).toEqual([
          {
            interactionToken: 'first-click',
            body: {
              content: `Approve failed: Database unavailable.`,
              flags: ephemeralFlag
            }
          }
        ]);

        expect(captureException).toHaveBeenCalledTimes(1);

        expect(await findCase(moderationCase)).toEqual(moderationCase);
        expect(discord.messages).toHaveLength(1);

        expect(await click(`approve:${moderationCase.id}`)).toEqual({
          statusCode: 200,
          body: deferredUpdate
        });

        await testApp.backgroundTasks.settled();

        expect(await findCase(moderationCase)).toMatchObject({ outcome: 'approved' });
        expect(discord.messages).toEqual([]);
      } finally {
        logError.mockRestore();
        captureException.mockRestore();
      }
    });

    test(`settles as moot a case whose screenshot left with its creator's account`, async () => {
      const moderationCase = await postReportCase();

      await testApp.prisma.creator.delete({ where: { id: creator.id } });

      expect(await click(`ban:${moderationCase.id}`)).toEqual({
        statusCode: 200,
        body: {
          type: 4,
          data: {
            content: `This screenshot no longer exists, the case is closed.`,
            flags: ephemeralFlag
          }
        }
      });

      await testApp.backgroundTasks.settled();

      expect(await findCase(moderationCase)).toMatchObject({
        outcome: 'moot',
        settledThrough: 'moot'
      });

      expect(discord.messages).toEqual([]);
    });
  });
});
