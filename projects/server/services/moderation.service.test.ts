import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Creator, ModerationCase, Screenshot } from '#prisma-lib/client';
import { nn } from '../../shared/utils/type-assertion';
import { NotFoundByIdError } from '../common/standard-error';
import {
  createBan,
  createCreator,
  createModerationCase,
  createScreenshot
} from '../testing/factories';
import { FakeDiscordApi } from '../testing/fake-discord-api';
import { fetchStub } from '../testing/fetch-stub';
import * as identifiers from '../testing/identifiers';
import { createTestApp, type TestApp } from '../testing/test-app';
import { ModerationCaseService } from './moderation-case.service';
import { ModerationCaseClaimedError, ModerationService } from './moderation.service';

describe('ModerationService', () => {
  let testApp: TestApp;

  let moderation: ModerationService;

  let discord: FakeDiscordApi;

  let creator: Creator;

  let screenshot: Screenshot;

  beforeEach(async () => {
    testApp = await createTestApp();

    moderation = testApp.app.get(ModerationService);

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

  function findCase(moderationCase: ModerationCase): Promise<ModerationCase> {
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

  describe('settleReport()', () => {
    test(`approves from the CLI: records the outcome and deletes the message`, async () => {
      const moderationCase = await postReportCase();

      await moderation.settleReport(screenshot.id, 'approve', { surface: 'cli' });

      await testApp.backgroundTasks.settled();

      expect(
        await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: screenshot.id } })
      ).toMatchObject({ isApproved: true, isReported: false, reportedById: null });

      const settledCase = await findCase(moderationCase);

      expect(settledCase).toMatchObject({
        outcome: 'approved',
        settledThrough: 'cli',
        settledByDiscordUserId: null,
        settleClaimedAt: null
      });

      expect(settledCase.settledAt).toBeInstanceOf(Date);

      expect(discord.deletedMessageIds).toEqual([nn(moderationCase.discordMessageId)]);
      expect(discord.messages).toEqual([]);
    });

    test(`deletes from the CLI, its own case spared from going moot`, async () => {
      const moderationCase = await postReportCase();

      await moderation.settleReport(screenshot.id, 'delete', { surface: 'cli' });

      await testApp.backgroundTasks.settled();

      expect(await testApp.prisma.screenshot.count({ where: { id: screenshot.id } })).toBe(0);

      expect(await findCase(moderationCase)).toMatchObject({
        outcome: 'deleted',
        settledThrough: 'cli'
      });

      expect(discord.deletedMessageIds).toEqual([nn(moderationCase.discordMessageId)]);
    });

    test(`bans the creator, their IPs and hardware IDs, and deletes from the CLI`, async () => {
      const reason =
        `one or more screenshots for city "city 1" was reported and ` +
        `judged to be inappropriate by our moderation team`;

      const moderationCase = await postReportCase();

      await moderation.settleReport(screenshot.id, 'ban', { surface: 'cli' });

      await testApp.backgroundTasks.settled();

      expect(await testApp.prisma.screenshot.count({ where: { id: screenshot.id } })).toBe(0);

      expect(
        await testApp.prisma.ban.findMany({
          where: { creatorId: creator.id },
          select: { ip: true, hwid: true, reason: true },
          orderBy: { bannedAt: 'asc' }
        })
      ).toEqual([
        { ip: null, hwid: null, reason },
        { ip: identifiers.ip1, hwid: null, reason },
        { ip: null, hwid: identifiers.hwid1, reason }
      ]);

      expect(await findCase(moderationCase)).toMatchObject({
        outcome: 'banned',
        settledThrough: 'cli'
      });

      expect(discord.deletedMessageIds).toEqual([nn(moderationCase.discordMessageId)]);
    });

    test(`skips the ban of a creator already banned, still deleting`, async () => {
      await createBan(testApp.prisma, { creatorId: creator.id });

      await moderation.settleReport(screenshot.id, 'ban', { surface: 'cli' });

      expect(await testApp.prisma.ban.count()).toBe(1);
      expect(await testApp.prisma.screenshot.count({ where: { id: screenshot.id } })).toBe(0);
    });

    test(`settles a report without a case as before, reaching no Discord`, async () => {
      await moderation.settleReport(screenshot.id, 'approve', { surface: 'cli' });

      await testApp.backgroundTasks.settled();

      expect(
        await testApp.prisma.screenshot.findUniqueOrThrow({ where: { id: screenshot.id } })
      ).toMatchObject({ isApproved: true, isReported: false });

      expect(await testApp.prisma.moderationCase.count()).toBe(0);
      expect(fetchStub.requests).toEqual([]);
    });

    test(`keeps the case pending and its message when the action fails`, async () => {
      const moderationCase = await postReportCase();

      await testApp.prisma.screenshot.delete({ where: { id: screenshot.id } });

      expect(
        moderation.settleReport(screenshot.id, 'approve', { surface: 'cli' })
      ).rejects.toBeInstanceOf(NotFoundByIdError);

      await testApp.backgroundTasks.settled();

      expect(await findCase(moderationCase)).toMatchObject({
        outcome: null,
        settleClaimedAt: null,
        discordMessageId: moderationCase.discordMessageId
      });

      expect(discord.deletedMessageIds).toEqual([]);
    });

    test(`runs nothing on a case another surface is settling`, async () => {
      const moderationCase = await createModerationCase(testApp.prisma, screenshot, {
        settleClaimedAt: new Date()
      });

      expect(
        moderation.settleReport(screenshot.id, 'delete', { surface: 'cli' })
      ).rejects.toBeInstanceOf(ModerationCaseClaimedError);

      expect(await testApp.prisma.screenshot.count({ where: { id: screenshot.id } })).toBe(1);
      expect(await findCase(moderationCase)).toMatchObject({ outcome: null });
    });
  });
});
