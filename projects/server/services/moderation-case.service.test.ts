import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import process from 'node:process';
import { Logger } from '@nestjs/common';
import * as sentry from '@sentry/bun';
import type { Creator, Screenshot } from '#prisma-lib/client';
import { minutes } from '../../shared/utils/duration';
import { nn } from '../../shared/utils/type-assertion';
import { viewerBaseUrl } from '../common/constants';
import { config } from '../config';
import {
  createCreator,
  createMod,
  createModerationCase,
  createScreenshot
} from '../testing/factories';
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
                  {
                    name: 'Creator',
                    value: `[Mayor 1](${viewerBaseUrl}/?creator=${creator.id})`,
                    inline: true
                  },
                  {
                    name: 'City',
                    value: `[City 1](${viewerBaseUrl}/city/${screenshot.id})`,
                    inline: true
                  },
                  { name: 'Uploaded', value: '<t:1792314000:f>', inline: true },
                  {
                    name: '4K image',
                    value: `[Open](${cdn}/${screenshot.imageUrl4K})`,
                    inline: true
                  },
                  {
                    name: 'Reported by',
                    value: `[Mayor 2](${viewerBaseUrl}/?creator=${reporter.id})`,
                    inline: true
                  },
                  { name: 'Reported', value: '<t:1792506600:f>', inline: true }
                ],
                image: { url: `${cdn}/${screenshot.imageUrlFHD}` }
              }
            ],
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 3,
                    label: 'Approve',
                    custom_id: `approve:${moderationCase.id}`
                  },
                  { type: 2, style: 4, label: 'Delete', custom_id: `delete:${moderationCase.id}` },
                  {
                    type: 2,
                    style: 4,
                    label: 'Ban creator and delete',
                    custom_id: `ban:${moderationCase.id}`
                  }
                ]
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
              {
                name: 'Creator',
                value: `[Anonymous](${viewerBaseUrl}/?creator=${unnamed.id})`,
                inline: true
              },
              { name: 'Reported by', value: 'Deleted account', inline: true }
            ])
          }
        ]
      });
    });

    test(`escapes Markdown in names, so they keep their viewer links`, async () => {
      const marked = await createCreator(testApp.prisma, { creatorName: '*[Mayor](_x_)*' });

      const markedScreenshot = await createScreenshot(testApp.prisma, marked, {
        cityName: '~City|`1`~'
      });

      await createModerationCase(testApp.prisma, markedScreenshot);

      await moderationCases.postPendingCases();

      expect(discord.messages[0]?.body).toMatchObject({
        embeds: [
          {
            fields: expect.arrayContaining([
              {
                name: 'Creator',
                value: `[\\*\\[Mayor\\]\\(\\_x\\_\\)\\*](${viewerBaseUrl}/?creator=${marked.id})`,
                inline: true
              },
              {
                name: 'City',
                value: `[\\~City\\|\\\`1\\\`\\~](${viewerBaseUrl}/city/${markedScreenshot.id})`,
                inline: true
              }
            ])
          }
        ]
      });
    });

    test(`posts a showcase case with the mod's details as one message`, async () => {
      const mod = await createMod(testApp.prisma);

      const showcasing = await createScreenshot(testApp.prisma, creator, {
        createdAt: uploadedAt,
        showcasedModId: mod.paradoxModId
      });

      const moderationCase = await createModerationCase(testApp.prisma, showcasing, {
        kind: 'showcased_mod',
        showcasedModId: mod.paradoxModId
      });

      expect(await moderationCases.postPendingCases()).toBe(1);

      const cdn = `${config.azure.cdn}/${config.azure.screenshotsContainer}`;

      expect(discord.messages).toEqual([
        {
          id: expect.any(String),
          body: {
            allowed_mentions: { parse: [] },
            embeds: [
              {
                title: 'Showcased mod',
                fields: [
                  {
                    name: 'Creator',
                    value: `[Mayor 1](${viewerBaseUrl}/?creator=${creator.id})`,
                    inline: true
                  },
                  {
                    name: 'City',
                    value: `[City 2](${viewerBaseUrl}/city/${showcasing.id})`,
                    inline: true
                  },
                  { name: 'Uploaded', value: '<t:1792314000:f>', inline: true },
                  {
                    name: '4K image',
                    value: `[Open](${cdn}/${showcasing.imageUrl4K})`,
                    inline: true
                  },
                  {
                    name: 'Mod',
                    value: '[Mod 1](https://mods.paradoxplaza.com/mods/80001/Windows)',
                    inline: true
                  },
                  { name: 'Author', value: 'Modder 1', inline: true }
                ],
                image: { url: `${cdn}/${showcasing.imageUrlFHD}` },
                thumbnail: { url: mod.thumbnailUrl }
              }
            ],
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 3,
                    label: 'Accept',
                    custom_id: `accept:${moderationCase.id}`
                  },
                  { type: 2, style: 4, label: 'Remove', custom_id: `remove:${moderationCase.id}` }
                ]
              }
            ]
          }
        }
      ]);
    });

    test(`marks a retired mod`, async () => {
      const mod = await createMod(testApp.prisma, { isRetired: true, name: 'Mod_1' });

      const showcasing = await createScreenshot(testApp.prisma, creator, {
        showcasedModId: mod.paradoxModId
      });

      await createModerationCase(testApp.prisma, showcasing, {
        kind: 'showcased_mod',
        showcasedModId: mod.paradoxModId
      });

      await moderationCases.postPendingCases();

      expect(discord.messages[0]?.body).toMatchObject({
        embeds: [
          {
            fields: expect.arrayContaining([
              {
                name: 'Mod',
                value: String.raw`[Mod\_1](https://mods.paradoxplaza.com/mods/80001/Windows) (retired)`,
                inline: true
              }
            ]),
            thumbnail: { url: mod.thumbnailUrl }
          }
        ]
      });
    });

    test(`shows a mod missing from the cache by its ID and link only`, async () => {
      const showcasing = await createScreenshot(testApp.prisma, creator, {
        showcasedModId: 74_604
      });

      await createModerationCase(testApp.prisma, showcasing, {
        kind: 'showcased_mod',
        showcasedModId: 74_604
      });

      await moderationCases.postPendingCases();

      // Without the author field.
      expect(discord.messages[0]?.body).toMatchObject({
        embeds: [
          {
            fields: [
              { name: 'Creator' },
              { name: 'City' },
              { name: 'Uploaded' },
              { name: '4K image' },
              {
                name: 'Mod',
                value: '[74604](https://mods.paradoxplaza.com/mods/74604/Windows)',
                inline: true
              }
            ]
          }
        ]
      });

      expect(discord.messages[0]?.body).not.toHaveProperty(['embeds', 0, 'thumbnail']);
    });

    test(`posts a near-duplicate case with both screenshots side by side as one message`, async () => {
      const older = await createScreenshot(testApp.prisma, creator, {
        createdAt: uploadedAt,
        favoritesCount: 12,
        favoritingPercentage: 8
      });

      const newer = await createScreenshot(testApp.prisma, creator, {
        createdAt: new Date('2026-10-19T09:00:00Z')
      });

      const moderationCase = await createModerationCase(testApp.prisma, newer, {
        kind: 'near_duplicate',
        pairedScreenshotId: older.id,
        pairDistance: 0.077
      });

      expect(await moderationCases.postPendingCases()).toBe(1);

      const cdn = `${config.azure.cdn}/${config.azure.screenshotsContainer}`;

      expect(discord.messages).toEqual([
        {
          id: expect.any(String),
          body: {
            allowed_mentions: { parse: [] },
            flags: 32_768,
            components: [
              {
                type: 17,
                components: [
                  {
                    type: 10,
                    content: `### Near-duplicate screenshots\n92% similar, by [Mayor 1](${viewerBaseUrl}/?creator=${creator.id})`
                  },
                  {
                    type: 12,
                    items: [
                      { media: { url: `${cdn}/${older.imageUrlFHD}` }, description: 'A (older)' },
                      {
                        media: { url: `${cdn}/${newer.imageUrlFHD}` },
                        description: 'B (latest upload)'
                      }
                    ]
                  },
                  {
                    type: 10,
                    content: `**A (older)**: [City 2](${viewerBaseUrl}/city/${older.id})\nUploaded <t:1792314000:f> · 12 likes, 8% like rate · [4K image](${cdn}/${older.imageUrl4K})`
                  },
                  {
                    type: 10,
                    content: `**B (latest upload)**: [City 3](${viewerBaseUrl}/city/${newer.id})\nUploaded <t:1792400400:f> · 0 likes, 0% like rate · [4K image](${cdn}/${newer.imageUrl4K})`
                  },
                  {
                    type: 1,
                    components: [
                      {
                        type: 2,
                        style: 4,
                        label: 'Keep A',
                        custom_id: `keepA:${moderationCase.id}`
                      },
                      {
                        type: 2,
                        style: 3,
                        label: 'Allow both',
                        custom_id: `allow:${moderationCase.id}`
                      },
                      {
                        type: 2,
                        style: 4,
                        label: 'Keep B',
                        custom_id: `keepB:${moderationCase.id}`
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
      ]);
    });

    test(`settles as moot, without posting, a near-duplicate case whose A left`, async () => {
      const newer = await createScreenshot(testApp.prisma, creator);

      const moderationCase = await createModerationCase(testApp.prisma, newer, {
        kind: 'near_duplicate',
        pairedScreenshotId: screenshot.id,
        pairDistance: 0.08
      });

      // Bypassing the screenshot service, which would have settled the case already.
      await testApp.prisma.screenshot.delete({ where: { id: screenshot.id } });

      expect(await moderationCases.postPendingCases()).toBe(0);

      expect(discord.messages).toEqual([]);

      expect(
        await testApp.prisma.moderationCase.findUniqueOrThrow({ where: { id: moderationCase.id } })
      ).toMatchObject({ outcome: 'moot', settledThrough: 'moot', discordMessageId: null });
    });

    test(`settles as moot, without posting, a showcase case whose screenshot changed mods`, async () => {
      const showcasing = await createScreenshot(testApp.prisma, creator, {
        showcasedModId: 87_755
      });

      const moderationCase = await createModerationCase(testApp.prisma, showcasing, {
        kind: 'showcased_mod',
        showcasedModId: 74_604
      });

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

  describe('openNearDuplicateCases()', () => {
    test(`opens one case per pair, whichever screenshot of it is embedded last`, async () => {
      const newer = await createScreenshot(testApp.prisma, creator, {
        createdAt: new Date('2026-10-19T09:00:00Z')
      });

      await moderationCases.openNearDuplicateCases(screenshot, [
        { screenshotId: newer.id, distance: 0.08 }
      ]);

      await moderationCases.openNearDuplicateCases(newer, [
        { screenshotId: screenshot.id, distance: 0.08 }
      ]);

      expect(
        await testApp.prisma.moderationCase.findMany({
          select: { kind: true, screenshotId: true, pairedScreenshotId: true }
        })
      ).toEqual([
        { kind: 'near_duplicate', screenshotId: newer.id, pairedScreenshotId: screenshot.id }
      ]);
    });
  });

  describe('settleCasesOfChangedShowcase()', () => {
    // An edit to another mod, then back before its moot runs: the second edit reuses the case.
    test(`spares the case of the mod the screenshot showcases when it runs`, async () => {
      const showcasing = await createScreenshot(testApp.prisma, creator, {
        showcasedModId: 74_604
      });

      const current = await createModerationCase(testApp.prisma, showcasing, {
        kind: 'showcased_mod',
        showcasedModId: 74_604
      });

      const previous = await createModerationCase(testApp.prisma, showcasing, {
        kind: 'showcased_mod',
        showcasedModId: 87_755,
        openedAt: new Date('2026-10-21T08:00:00Z')
      });

      await moderationCases.settleCasesOfChangedShowcase(showcasing.id);

      expect(
        await testApp.prisma.moderationCase.findMany({
          where: { id: { in: [current.id, previous.id] } },
          select: { id: true, outcome: true },
          orderBy: { openedAt: 'asc' }
        })
      ).toEqual([
        { id: current.id, outcome: null },
        { id: previous.id, outcome: 'moot' }
      ]);
    });
  });
});
