import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as sentry from '@sentry/bun';
import {
  type ModerationCase,
  type ModerationCaseKind,
  type ModerationCaseOutcome,
  Prisma,
  type Screenshot
} from '#prisma-lib/client';
import { allFulfilled } from '../../shared/utils/all-fulfilled';
import { minutes } from '../../shared/utils/duration';
import type { JsonObject } from '../../shared/utils/json';
import { config } from '../config';
import { BackgroundTasksService } from './background-tasks.service';
import { DiscordService } from './discord.service';
import { PrismaService } from './prisma.service';
import { ScreenshotStorageService } from './screenshot-storage.service';

/**
 * Who settles a case: a moderator through Discord or the CLI, or the server for a moot case.
 */
export type ModerationCaseSettler =
  | { readonly surface: 'cli' }
  | { readonly surface: 'discord'; readonly discordUserId: string }
  | { readonly surface: 'moot' };

/**
 * Lifecycle of moderation cases: opening them, settling them through one path whatever the
 * surface, and posting the pending ones to Discord in a daily batch.
 * A settle and a post each take the case with one conditional update, its claim, so concurrent
 * callers produce one outcome and one message.
 */
@Injectable()
export class ModerationCaseService {
  /**
   * After this delay a claim lapses, so a settle or a post interrupted by a crash leaves the case
   * pending.
   */
  private static readonly claimLapseMinutes = 5;

  /**
   * Matches a case without an outcome.
   */
  private static readonly unsettled: Prisma.ModerationCaseWhereInput = { OR: absent('outcome') };

  private static readonly unposted: Prisma.ModerationCaseWhereInput = {
    OR: absent('discordMessageId')
  };

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(BackgroundTasksService)
  private readonly backgroundTasks!: BackgroundTasksService;

  @Inject(DiscordService)
  private readonly discord!: DiscordService;

  @Inject(ScreenshotStorageService)
  private readonly screenshotStorage!: ScreenshotStorageService;

  private readonly logger = new Logger(ModerationCaseService.name);

  /**
   * Opens a report case on the screenshot within the caller's transaction, unless one is pending
   * already, as when a second player reports the same screenshot.
   */
  public async openReportCase(
    screenshotId: Screenshot['id'],
    tx: Prisma.TransactionClient
  ): Promise<void> {
    const pendingCase = await tx.moderationCase.findFirst({
      where: { kind: 'report', screenshotId, ...ModerationCaseService.unsettled },
      select: { id: true }
    });

    if (!pendingCase) {
      await tx.moderationCase.create({ data: { kind: 'report', screenshotId } });
    }
  }

  /**
   * Finds the case of a kind on a screenshot that has no outcome yet, claimed or not.
   */
  public findUnsettledCase(
    kind: ModerationCaseKind,
    screenshotId: Screenshot['id']
  ): Promise<ModerationCase | null> {
    return this.prisma.moderationCase.findFirst({
      where: { kind, screenshotId, ...ModerationCaseService.unsettled }
    });
  }

  /**
   * Settles a case: takes its settle claim, runs `action`, records `outcome` with who settled it,
   * then deletes its Discord message in the background.
   * A failed action releases the claim and rethrows, leaving the case pending and its message.
   *
   * @returns `false` without running `action` when the case is settled already, or another caller
   *   holds its claim.
   */
  public async settle(
    caseId: ModerationCase['id'],
    outcome: ModerationCaseOutcome,
    settler: ModerationCaseSettler,
    action: () => Promise<unknown>
  ): Promise<boolean> {
    const claimedAt = new Date();

    const claim = await this.prisma.moderationCase.updateMany({
      where: {
        id: caseId,
        AND: [ModerationCaseService.unsettled, this.claimFree('settleClaimedAt', claimedAt)]
      },
      data: { settleClaimedAt: claimedAt }
    });

    if (!claim.count) {
      return false;
    }

    try {
      await action();
    } catch (error) {
      await this.releaseClaim(caseId, 'settleClaimedAt');

      throw error;
    }

    // Returns the message ID a post in flight may have stored meanwhile; a post storing it later
    // finds the outcome and deletes its message itself.
    const settledCase = await this.prisma.moderationCase.update({
      where: { id: caseId },
      data: {
        outcome,
        settledThrough: settler.surface,
        settledByDiscordUserId: settler.surface == 'discord' ? settler.discordUserId : Prisma.skip,
        settledAt: new Date(),
        settleClaimedAt: { unset: true }
      }
    });

    this.logger.log(`Settled moderation case #${caseId} as ${outcome} (${settler.surface}).`);

    if (settledCase.discordMessageId) {
      this.deleteMessage(settledCase.id, settledCase.discordMessageId);
    }

    return true;
  }

  /**
   * Settles as moot every pending case naming a deleted screenshot, as its subject or as A.
   * A case being settled holds its claim and is spared: its own settle deleted the screenshot.
   */
  public async settleCasesOfDeletedScreenshot(screenshotId: Screenshot['id']): Promise<void> {
    const cases = await this.prisma.moderationCase.findMany({
      where: {
        AND: [
          ModerationCaseService.unsettled,
          { OR: [{ screenshotId }, { pairedScreenshotId: screenshotId }] }
        ]
      },
      select: { id: true }
    });

    await allFulfilled(cases.map(({ id }) => this.settleAsMoot(id)));
  }

  /**
   * Runs {@link postPendingCases} on the configured schedule, reporting its failure.
   * The CLI module schedules no cron, so this runs on the server only.
   */
  @Cron(config.discord.batchCron, { timeZone: config.discord.batchTimeZone })
  public async postPendingCasesCron(): Promise<void> {
    try {
      await this.postPendingCases();
    } catch (error) {
      this.logger.error(`Failed CRON post of the pending moderation cases.`, error);

      sentry.captureException(error);
    }
  }

  /**
   * Posts each pending case not yet posted to Discord, one message each, sequentially to stay
   * within Discord's rate limit.
   * A case that went moot meanwhile settles as moot without being posted.
   * A failed post is logged and reported, and the case stays unposted for the next run.
   * Posts nothing while Discord is disabled.
   *
   * @returns The number of cases posted.
   */
  public async postPendingCases(): Promise<number> {
    if (!config.discord.isEnabled) {
      return 0;
    }

    const now = new Date();

    const cases = await this.prisma.moderationCase.findMany({
      where: {
        AND: [
          ModerationCaseService.unsettled,
          ModerationCaseService.unposted,
          this.claimFree('settleClaimedAt', now),
          this.claimFree('postClaimedAt', now)
        ]
      },
      orderBy: { openedAt: 'asc' },
      select: { id: true }
    });

    let postedCount = 0;

    for (const { id } of cases) {
      try {
        // oxlint-disable-next-line no-await-in-loop - sequential, within Discord's rate limit
        if (await this.postCase(id)) {
          postedCount++;
        }
      } catch (error) {
        this.logger.error(`Failed to post moderation case #${id} to Discord.`, error);

        sentry.captureException(error);
      }
    }

    this.logger.log(`Posted ${postedCount} of ${cases.length} pending moderation cases.`);

    return postedCount;
  }

  /**
   * Takes the case's post claim, re-checks the case is live, and posts it.
   * A failure releases the claim, so the next run posts the case.
   *
   * @returns Whether the case was posted, rather than taken by another post or gone moot.
   */
  private async postCase(caseId: ModerationCase['id']): Promise<boolean> {
    const claimedAt = new Date();

    const claim = await this.prisma.moderationCase.updateMany({
      where: {
        id: caseId,
        AND: [ModerationCaseService.unposted, this.claimFree('postClaimedAt', claimedAt)]
      },
      data: { postClaimedAt: claimedAt }
    });

    if (!claim.count) {
      return false;
    }

    try {
      const moderationCase = await this.prisma.moderationCase.findUniqueOrThrow({
        where: { id: caseId }
      });

      const message = await this.buildMessage(moderationCase);

      if (!message) {
        await this.settleAsMoot(caseId);

        return false;
      }

      const messageId = await this.discord.createMessage(message);

      const postedCase = await this.prisma.moderationCase.update({
        where: { id: caseId },
        data: { discordMessageId: messageId, postedAt: new Date(), postClaimedAt: { unset: true } }
      });

      // The case settled while the post was in flight, which found no message to delete.
      if (postedCase.outcome) {
        await this.discord.deleteMessage(messageId);
      }

      return true;
    } catch (error) {
      await this.releaseClaim(caseId, 'postClaimedAt');

      throw error;
    }
  }

  private settleAsMoot(caseId: ModerationCase['id']): Promise<boolean> {
    return this.settle(caseId, 'moot', { surface: 'moot' }, () => Promise.resolve());
  }

  /**
   * Builds the case's Discord message from its records as they are now.
   *
   * @returns `undefined` when the case went moot, its screenshot gone.
   */
  private async buildMessage(moderationCase: ModerationCase): Promise<JsonObject | undefined> {
    const screenshot = await this.prisma.screenshot.findUnique({
      where: { id: moderationCase.screenshotId },
      include: { creator: true, reportedBy: true }
    });

    if (!screenshot) {
      return undefined;
    }

    // A reporter whose account was deleted is unset on the screenshot.
    const reporterName = screenshot.reportedBy
      ? (screenshot.reportedBy.creatorName ?? `Anonymous`)
      : `Deleted account`;

    return {
      // Names never ping anyone.
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: `Reported screenshot`,
          fields: [
            ...this.screenshotFields(screenshot),
            { name: `Reported by`, value: reporterName, inline: true },
            { name: `Reported`, value: discordTimestamp(moderationCase.openedAt), inline: true }
          ],
          image: { url: this.screenshotStorage.getScreenshotUrl(screenshot.imageUrlFHD) }
        }
      ]
    };
  }

  /**
   * The fields every kind of case shows about a screenshot.
   */
  private screenshotFields(
    screenshot: Pick<Screenshot, 'cityName' | 'createdAt' | 'imageUrl4K'> & {
      readonly creator: { readonly creatorName: string | null };
    }
  ): JsonObject[] {
    const imageUrl4K = this.screenshotStorage.getScreenshotUrl(screenshot.imageUrl4K);

    return [
      { name: `Creator`, value: screenshot.creator.creatorName ?? `Anonymous`, inline: true },
      { name: `City`, value: screenshot.cityName, inline: true },
      { name: `Uploaded`, value: discordTimestamp(screenshot.createdAt), inline: true },
      { name: `4K image`, value: `[Open](${imageUrl4K})`, inline: true }
    ];
  }

  /**
   * Deletes a case's message in the background, unless Discord was switched off since it posted.
   */
  private deleteMessage(caseId: ModerationCase['id'], messageId: string): void {
    if (!config.discord.isEnabled) {
      return;
    }

    this.backgroundTasks.run(
      `Failed to delete the Discord message of moderation case #${caseId}.`,
      () => this.discord.deleteMessage(messageId)
    );
  }

  /**
   * Matches a case whose claim is free or lapsed.
   */
  private claimFree(
    claim: 'settleClaimedAt' | 'postClaimedAt',
    now: Date
  ): Prisma.ModerationCaseWhereInput {
    const lapsedBefore = new Date(now.getTime() - minutes(ModerationCaseService.claimLapseMinutes));

    return { OR: [...absent(claim), { [claim]: { lt: lapsedBefore } }] };
  }

  private async releaseClaim(
    caseId: ModerationCase['id'],
    claim: 'settleClaimedAt' | 'postClaimedAt'
  ): Promise<void> {
    await this.prisma.moderationCase.update({
      where: { id: caseId },
      data: { [claim]: { unset: true } }
    });
  }
}

/**
 * Matches a case whose optional field holds no value, which Prisma tells apart absent or null.
 */
function absent(
  field: 'outcome' | 'discordMessageId' | 'settleClaimedAt' | 'postClaimedAt'
): Prisma.ModerationCaseWhereInput[] {
  return [{ [field]: { isSet: false } }, { [field]: null }];
}

/**
 * Formats a date as a Discord timestamp, which each reader sees in their own time zone.
 */
function discordTimestamp(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:f>`;
}
