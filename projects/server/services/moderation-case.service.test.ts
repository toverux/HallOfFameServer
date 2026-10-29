import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import process from 'node:process';
import { Logger } from '@nestjs/common';
import * as sentry from '@sentry/bun';
import type { Creator, Screenshot } from '#prisma-lib/client';
import { minutes } from '../../shared/utils/duration';
import { nn } from '../../shared/utils/type-assertion';
import { config } from '../config';
import { createCreator, createModerationCase, createScreenshot } from '../testing/factories';
import { FakeDiscordApi } from '../testing/fake-discord-api';
import { fetchStub } from '../testing/fetch-stub';
import { createTestApp, type TestApp } from '../testing/test-app';
import { ModerationCaseService } from './moderation-case.service';
import { ModerationService } from './moderation.service';

const uploadedAt = new Date('2026-10-18T09:00:00Z');

describe('ModerationCaseService', () => {
  let testApp: TestApp;

  let moderationCases: ModerationCaseService;

  let discord: FakeDiscordApi;

  let creator: Creator;

  let reporter: Creator;

  let screenshot: Screenshot;

  beforeEach(async () => {
    testApp = await createTestApp();

    moderationCases = testApp.app.get(ModerationCaseService);

    discord = new FakeDiscordApi().install();

    creator = await createCreator(testApp.prisma);
    reporter = await createCreator(testApp.prisma);

    screenshot = await createScreenshot(testApp.prisma, creator, {
      createdAt: uploadedAt,
      isReported: true,
      reportedById: reporter.id
    });
  });

  afterEach(async () => {
    await testApp.app.close();
  });

  describe('postPendingCases()', () => {
    test(`posts a report case as one message, storing its ID`, async () => {
      const moderationCase = await createModerationCase(testApp.prisma, screenshot);

      expect(await moderationCases.postPendingCases()).toBe(1);

      const cdn = `${config.azure.cdn}/${config.azure.screenshotsContainer}`;

      expect(discord.messages).toEqual([
        {
          id: expect.any(String),
          body: {
            allowed_mentions: { parse: [] },
            embeds: [
              {
                title: 'Reported screenshot',
                fields: [
                  { name: 'Creator', value: 'Mayor 1', inline: true },
                  { name: 'City', value: 'City 1', inline: true },
                  { name: 'Uploaded', value: '<t:1792314000:f>', inline: true },
                  {
                    name: '4K image',
                    value: `[Open](${cdn}/${screenshot.imageUrl4K})`,
                    inline: true
                  },
                  { name: 'Reported by', value: 'Mayor 2', inline: true },
                  { name: 'Reported', value: '<t:1792506600:f>', inline: true }
                ],
                image: { url: `${cdn}/${screenshot.imageUrlFHD}` }
              }
            ]
          }
        }
      ]);

      expect(fetchStub.sentRequests.map(request => request.headers.get('authorization'))).toEqual([
        'Bot discord-inert'
      ]);

      const postedCase = await testApp.prisma.moderationCase.findUniqueOrThrow({
        where: { id: moderationCase.id }
      });

      expect(postedCase).toMatchObject({
        discordMessageId: discord.messages[0]?.id,
        postClaimedAt: null,
        outcome: null
      });

      expect(postedCase.postedAt).toBeInstanceOf(Date);
    });

    test(`shows placeholders for an unnamed creator and a deleted reporter`, async () => {
      const unnamed = await createCreator(testApp.prisma, { creatorName: null });

      const unnamedScreenshot = await createScreenshot(testApp.prisma, unnamed, {
        isReported: true,
        reportedById: reporter.id
      });

      await createModerationCase(testApp.prisma, unnamedScreenshot);

      await testApp.prisma.creator.delete({ where: { id: reporter.id } });

      await moderationCases.postPendingCases();

      expect(discord.messages[0]?.body).toMatchObject({
        embeds: [
          {
            fields: expect.arrayContaining([
              { name: 'Creator', value: 'Anonymous', inline: true },
              { name: 'Reported by', value: 'Deleted account', inline: true }
            ])
          }
        ]
      });
    });

    test(`posts each case once, oldest first, and no settled case`, async () => {
      const other = await createScreenshot(testApp.prisma, creator);

      const newer = await createModerationCase(testApp.prisma, other, {
        openedAt: new Date('2026-10-21T08:00:00Z')
      });

      const older = await createModerationCase(testApp.prisma, screenshot);

      await createModerationCase(testApp.prisma, screenshot, {
        outcome: 'approved',
        settledThrough: 'cli',
        settledAt: new Date('2026-10-20T15:00:00Z')
      });

      expect(await moderationCases.postPendingCases()).toBe(2);
      expect(await moderationCases.postPendingCases()).toBe(0);

      const postedCases = await testApp.prisma.moderationCase.findMany({
        where: { id: { in: [older.id, newer.id] } },
        orderBy: { discordMessageId: 'asc' }
      });

      expect(postedCases.map(postedCase => postedCase.id)).toEqual([older.id, newer.id]);
      expect(discord.messages).toHaveLength(2);
    });

    test(`settles as moot, without posting, a case whose screenshot left meanwhile`, async () => {
      const moderationCase = await createModerationCase(testApp.prisma, screenshot);

      // As an account deletion does, bypassing the screenshot service.
      await testApp.prisma.creator.delete({ where: { id: creator.id } });

      expect(await moderationCases.postPendingCases()).toBe(0);

      expect(discord.messages).toEqual([]);

      expect(
        await testApp.prisma.moderationCase.findUniqueOrThrow({ where: { id: moderationCase.id } })
      ).toMatchObject({ outcome: 'moot', settledThrough: 'moot', discordMessageId: null });
    });

    test(`posts on the next run a case whose post failed, logging and reporting it`, async () => {
      const logError = spyOn(Logger.prototype, 'error').mockReturnValue(undefined);
      const captureException = spyOn(sentry, 'captureException').mockReturnValue('');

      try {
        const moderationCase = await createModerationCase(testApp.prisma, screenshot);

        discord.failNextPosts(1);

        expect(await moderationCases.postPendingCases()).toBe(0);

        expect(logError).toHaveBeenCalledWith(
          `Failed to post moderation case #${moderationCase.id} to Discord.`,
          expect.any(Error)
        );

        expect(captureException).toHaveBeenCalledTimes(1);

        expect(
          await testApp.prisma.moderationCase.findUniqueOrThrow({
            where: { id: moderationCase.id }
          })
        ).toMatchObject({ discordMessageId: null, postClaimedAt: null });

        expect(await moderationCases.postPendingCases()).toBe(1);
        expect(discord.messages).toHaveLength(1);
      } finally {
        logError.mockRestore();
        captureException.mockRestore();
      }
    });

    test(`posts a case whose post claim lapsed, not one another post holds`, async () => {
      const lapsed = await createModerationCase(testApp.prisma, screenshot, {
        postClaimedAt: new Date(Date.now() - minutes(6))
      });

      await createModerationCase(testApp.prisma, await createScreenshot(testApp.prisma, creator), {
        postClaimedAt: new Date(Date.now() - minutes(1))
      });

      expect(await moderationCases.postPendingCases()).toBe(1);

      expect(
        await testApp.prisma.moderationCase.findUniqueOrThrow({ where: { id: lapsed.id } })
      ).toMatchObject({ discordMessageId: discord.messages[0]?.id });
    });

    test(`deletes its own message when the case settled while the post was in flight`, async () => {
      const moderationCase = await createModerationCase(testApp.prisma, screenshot);

      discord.beforePost = async (): Promise<void> => {
        await testApp.app
          .get(ModerationService)
          .settleReport(screenshot.id, 'approve', { surface: 'cli' });
      };

      expect(await moderationCases.postPendingCases()).toBe(1);

      await testApp.backgroundTasks.settled();

      const settledCase = await testApp.prisma.moderationCase.findUniqueOrThrow({
        where: { id: moderationCase.id }
      });

      expect(settledCase).toMatchObject({
        outcome: 'approved',
        discordMessageId: expect.any(String)
      });
      expect(discord.deletedMessageIds).toEqual([nn(settledCase.discordMessageId)]);
      expect(discord.messages).toEqual([]);
    });

    test(`posts nothing while Discord is disabled`, async () => {
      const botToken = process.env.HOF_DISCORD_BOT_TOKEN;

      process.env.HOF_DISCORD_BOT_TOKEN = 'disabled';

      try {
        await createModerationCase(testApp.prisma, screenshot);

        expect(await moderationCases.postPendingCases()).toBe(0);

        expect(fetchStub.requests).toEqual([]);
      } finally {
        process.env.HOF_DISCORD_BOT_TOKEN = botToken;
      }
    });
  });
});
