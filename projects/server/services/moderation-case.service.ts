import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as sentry from '@sentry/bun';
import {
  type Creator,
  type Mod,
  type ModerationCase,
  type ModerationCaseKind,
  type ModerationCaseOutcome,
  Prisma,
  type Screenshot
} from '#prisma-lib/client';
import { allFulfilled } from '../../shared/utils/all-fulfilled';
import { minutes } from '../../shared/utils/duration';
import type { JsonObject } from '../../shared/utils/json';
import { nn, unreachable } from '../../shared/utils/type-assertion';
import { paradoxModUrl, viewerBaseUrl } from '../common/constants';
import { config } from '../config';
import { BackgroundTasksService } from './background-tasks.service';
import { DiscordService } from './discord.service';
import { moderationCaseButtons } from './moderation-case-actions';
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
 * An item's pending case: the case of a kind on a screenshot, for a showcase the one opened for its
 * mod, for a pair the one opened with A.
 */
export interface UnsettledCaseQuery {
  readonly kind: ModerationCaseKind;
  readonly screenshotId: Screenshot['id'];
  readonly showcasedModId?: number;
  readonly pairedScreenshotId?: Screenshot['id'];
}

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

  /**
   * Discord's message flag for a message made of layout components, which then holds no embeds.
   */
  // oxlint-disable-next-line no-bitwise, no-magic-numbers - written as Discord documents it
  private static readonly componentsV2Flag = 1 << 15;

  /**
   * Discord's layout component types this service builds messages with.
   */
  private static readonly componentType = {
    textDisplay: 10,
    mediaGallery: 12,
    container: 17
  } as const;

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
    if (!(await this.findUnsettledCase({ kind: 'report', screenshotId }, tx))) {
      await tx.moderationCase.create({ data: { kind: 'report', screenshotId } });
    }
  }

  /**
   * Opens a showcase case on the screenshot for its showcased mod within the caller's transaction,
   * unless one is pending for that mod already.
   * A pending case for another mod goes moot through {@link settleCasesOfChangedShowcase}.
   */
  public async openShowcaseCase(
    screenshotId: Screenshot['id'],
    showcasedModId: number,
    tx: Prisma.TransactionClient
  ): Promise<void> {
    if (
      !(await this.findUnsettledCase({ kind: 'showcased_mod', screenshotId, showcasedModId }, tx))
    ) {
      await tx.moderationCase.create({
        data: { kind: 'showcased_mod', screenshotId, showcasedModId }
      });
    }
  }

  /**
   * Opens a near-duplicate case for each of the upload's neighbours by the same creator, unless one
   * is pending for that pair already.
   * Neighbours by other creators are noise: semantically close images, not duplicates.
   */
  public async openNearDuplicateCases(
    screenshot: Pick<Screenshot, 'id' | 'creatorId' | 'createdAt'>,
    neighbours: ReadonlyArray<{
      readonly screenshotId: Screenshot['id'];
      readonly distance: number;
    }>
  ): Promise<void> {
    const distances = new Map(
      neighbours.map(({ screenshotId, distance }) => [screenshotId, distance])
    );

    const creatorScreenshots = await this.prisma.screenshot.findMany({
      where: {
        id: { in: [...distances.keys()] },
        creatorId: screenshot.creatorId
      },
      select: { id: true, createdAt: true }
    });

    await allFulfilled(
      creatorScreenshots.map(async neighbour => {
        const { a, b } = orientPair(screenshot, neighbour);

        if (
          await this.findUnsettledCase({
            kind: 'near_duplicate',
            screenshotId: b.id,
            pairedScreenshotId: a.id
          })
        ) {
          return;
        }

        await this.prisma.moderationCase.create({
          data: {
            kind: 'near_duplicate',
            screenshotId: b.id,
            pairedScreenshotId: a.id,
            pairDistance: nn(distances.get(neighbour.id))
          }
        });
      })
    );
  }

  public findCase(caseId: ModerationCase['id']): Promise<ModerationCase | null> {
    return this.prisma.moderationCase.findUnique({ where: { id: caseId } });
  }

  /**
   * Finds an item's case that has no outcome yet, claimed or not, through the caller's transaction
   * when it passes one.
   */
  public findUnsettledCase(
    item: UnsettledCaseQuery,
    client: Prisma.TransactionClient = this.prisma
  ): Promise<ModerationCase | null> {
    return client.moderationCase.findFirst({
      where: {
        kind: item.kind,
        screenshotId: item.screenshotId,
        showcasedModId: item.showcasedModId ?? Prisma.skip,
        pairedScreenshotId: item.pairedScreenshotId ?? Prisma.skip,
        ...ModerationCaseService.unsettled
      }
    });
  }

  /**
   * Whether the records a case is about are all still there, and a showcase case's screenshot still
   * showcases the mod the case was opened for: a deletion that bypasses the screenshot service, as
   * an account deletion does, leaves the case pending.
   */
  public async isLive(moderationCase: ModerationCase): Promise<boolean> {
    const screenshotIds = [moderationCase.screenshotId, moderationCase.pairedScreenshotId].filter(
      id => id != null
    );

    const screenshots = await this.prisma.screenshot.findMany({
      where: { id: { in: screenshotIds } },
      select: { showcasedModId: true }
    });

    return (
      screenshots.length == screenshotIds.length &&
      (moderationCase.kind != 'showcased_mod' ||
        screenshots[0]?.showcasedModId == moderationCase.showcasedModId)
    );
  }

  /**
   * Settles a case: takes its settle claim, then settles it with {@link settleClaimed}.
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
    if (!(await this.claimSettle(caseId))) {
      return false;
    }

    await this.settleClaimed(caseId, outcome, settler, action);

    return true;
  }

  /**
   * Takes a case's settle claim, so the caller alone runs its action.
   *
   * @returns `false` when the case is settled already, or another caller holds its claim.
   */
  public async claimSettle(caseId: ModerationCase['id']): Promise<boolean> {
    const claimedAt = new Date();

    const claim = await this.prisma.moderationCase.updateMany({
      where: {
        id: caseId,
        AND: [ModerationCaseService.unsettled, this.claimFree('settleClaimedAt', claimedAt)]
      },
      data: { settleClaimedAt: claimedAt }
    });

    return claim.count > 0;
  }

  /**
   * Settles a case whose settle claim the caller holds: runs `action`, records `outcome` with who
   * settled it, then deletes its Discord message in the background.
   * A failed action releases the claim and rethrows, leaving the case pending and its message.
   */
  public async settleClaimed(
    caseId: ModerationCase['id'],
    outcome: ModerationCaseOutcome,
    settler: ModerationCaseSettler,
    action: () => Promise<unknown>
  ): Promise<void> {
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
  }

  /**
   * @returns `false` when the case is settled already, or another caller holds its claim.
   */
  public settleAsMoot(caseId: ModerationCase['id']): Promise<boolean> {
    return this.settle(caseId, 'moot', { surface: 'moot' }, () => Promise.resolve());
  }

  /**
   * Deletes a case's message in the background, unless Discord was switched off since it posted.
   */
  public deleteMessage(caseId: ModerationCase['id'], messageId: string): void {
    if (!config.discord.isEnabled) {
      return;
    }

    this.backgroundTasks.run(
      `Failed to delete the Discord message of moderation case #${caseId}.`,
      () => this.discord.deleteMessage(messageId)
    );
  }

  /**
   * Settles as moot every pending case naming a deleted screenshot, as its subject or as A.
   * A case being settled holds its claim and is spared: its own settle deleted the screenshot.
   */
  public settleCasesOfDeletedScreenshot(screenshotId: Screenshot['id']): Promise<void> {
    return this.settleAsMootWhere({
      AND: [
        ModerationCaseService.unsettled,
        { OR: [{ screenshotId }, { pairedScreenshotId: screenshotId }] }
      ]
    });
  }

  /**
   * Settles as moot every pending showcase case on the screenshot opened for another mod than the
   * one it showcases now, or for any mod once it showcases none.
   * It reads the screenshot's mod as it runs: an edit back to a mod reuses that mod's pending case.
   */
  public async settleCasesOfChangedShowcase(screenshotId: Screenshot['id']): Promise<void> {
    const screenshot = await this.prisma.screenshot.findUnique({
      where: { id: screenshotId },
      select: { showcasedModId: true }
    });

    const showcasedModId = screenshot?.showcasedModId;

    await this.settleAsMootWhere({
      kind: 'showcased_mod',
      screenshotId,
      showcasedModId: showcasedModId == null ? Prisma.skip : { not: showcasedModId },
      ...ModerationCaseService.unsettled
    });
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

      const message = (await this.isLive(moderationCase))
        ? await this.buildMessage(moderationCase)
        : undefined;

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

  /**
   * Builds the case's Discord message from its records as they are now.
   *
   * @returns `undefined` when the case went moot, a screenshot of it gone.
   */
  private async buildMessage(moderationCase: ModerationCase): Promise<JsonObject | undefined> {
    const screenshot = await this.prisma.screenshot.findUnique({
      where: { id: moderationCase.screenshotId },
      include: { creator: true, reportedBy: true }
    });

    if (!screenshot) {
      return undefined;
    }

    const image = { url: this.screenshotStorage.getScreenshotUrl(screenshot.imageUrlFHD) };

    switch (moderationCase.kind) {
      case 'report': {
        // A reporter whose account was deleted is unset on the screenshot.
        const reporter = screenshot.reportedBy
          ? creatorLink(screenshot.reportedBy)
          : `Deleted account`;

        return embedMessage(moderationCase, {
          title: `Reported screenshot`,
          fields: [
            ...this.screenshotFields(screenshot),
            { name: `Reported by`, value: reporter, inline: true },
            { name: `Reported`, value: discordTimestamp(moderationCase.openedAt), inline: true }
          ],
          image
        });
      }
      case 'showcased_mod': {
        const modId = nn(moderationCase.showcasedModId);

        // Read directly rather than through the mod service, which leaves out a retired mod.
        const mod = await this.prisma.mod.findUnique({ where: { paradoxModId: modId } });

        return embedMessage(moderationCase, {
          title: `Showcased mod`,
          fields: [...this.screenshotFields(screenshot), ...showcasedModFields(modId, mod)],
          image,
          ...(mod && { thumbnail: { url: mod.thumbnailUrl } })
        });
      }
      case 'near_duplicate': {
        const older = await this.prisma.screenshot.findUnique({
          where: { id: nn(moderationCase.pairedScreenshotId) }
        });

        return older
          ? this.buildNearDuplicateMessage(moderationCase, older, screenshot)
          : undefined;
      }
      default: {
        return unreachable(moderationCase.kind);
      }
    }
  }

  /**
   * A message of Discord's layout components rather than embeds, as a media gallery shows A and B
   * side by side in one message, where an embed holds one image.
   * Both screenshots are by the same creator.
   */
  private buildNearDuplicateMessage(
    moderationCase: ModerationCase,
    older: Screenshot,
    newer: Screenshot & { readonly creator: Creator }
  ): JsonObject {
    // Rounded as `moderate merge` shows it.
    const similarity = Math.round(100 * (1 - nn(moderationCase.pairDistance)));

    const sides = [
      { label: `A (older)`, screenshot: older },
      { label: `B (latest upload)`, screenshot: newer }
    ];

    const header = [
      `### Near-duplicate screenshots`,
      `${similarity}% similar, by ${creatorLink(newer.creator)}`
    ].join('\n');

    return {
      // Names never ping anyone.
      allowed_mentions: { parse: [] },
      flags: ModerationCaseService.componentsV2Flag,
      components: [
        {
          type: ModerationCaseService.componentType.container,
          components: [
            { type: ModerationCaseService.componentType.textDisplay, content: header },
            {
              type: ModerationCaseService.componentType.mediaGallery,
              items: sides.map(({ label, screenshot }) => ({
                media: { url: this.screenshotStorage.getScreenshotUrl(screenshot.imageUrlFHD) },
                description: label
              }))
            },
            ...sides.map(({ label, screenshot }) => ({
              type: ModerationCaseService.componentType.textDisplay,
              content: this.nearDuplicateSideText(label, screenshot)
            })),
            ...moderationCaseButtons(moderationCase)
          ]
        }
      ]
    };
  }

  private nearDuplicateSideText(label: string, screenshot: Screenshot): string {
    const imageUrl4K = this.screenshotStorage.getScreenshotUrl(screenshot.imageUrl4K);

    return [
      `**${label}**: ${cityLink(screenshot)}`,
      [
        `Uploaded ${discordTimestamp(screenshot.createdAt)}`,
        `${screenshot.favoritesCount} likes, ${screenshot.favoritingPercentage}% like rate`,
        `[4K image](${imageUrl4K})`
      ].join(' · ')
    ].join('\n');
  }

  /**
   * The fields every kind of case shows about a screenshot, the creator and the city linking to the
   * viewer directly, so the moderator's clicks count none of the viewer clicks the redirect routes
   * track.
   */
  private screenshotFields(
    screenshot: Pick<Screenshot, 'id' | 'cityName' | 'createdAt' | 'imageUrl4K'> & {
      readonly creator: Pick<Creator, 'id' | 'creatorName'>;
    }
  ): JsonObject[] {
    const imageUrl4K = this.screenshotStorage.getScreenshotUrl(screenshot.imageUrl4K);

    return [
      { name: `Creator`, value: creatorLink(screenshot.creator), inline: true },
      { name: `City`, value: cityLink(screenshot), inline: true },
      { name: `Uploaded`, value: discordTimestamp(screenshot.createdAt), inline: true },
      { name: `4K image`, value: `[Open](${imageUrl4K})`, inline: true }
    ];
  }

  private async settleAsMootWhere(where: Prisma.ModerationCaseWhereInput): Promise<void> {
    const cases = await this.prisma.moderationCase.findMany({ where, select: { id: true } });

    await allFulfilled(cases.map(({ id }) => this.settleAsMoot(id)));
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
 * Orients a near-duplicate pair: the older screenshot is A, the newer B, ties broken by ID, so both
 * screenshots of a pair orient it the same way.
 */
export function orientPair<T extends Pick<Screenshot, 'id' | 'createdAt'>>(
  first: T,
  second: T
): { readonly a: T; readonly b: T } {
  const isFirstOlder =
    first.createdAt.getTime() == second.createdAt.getTime()
      ? first.id < second.id
      : first.createdAt < second.createdAt;

  return isFirstOlder ? { a: first, b: second } : { a: second, b: first };
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
 * Wraps a case's embed into its message, with the buttons of its kind.
 */
function embedMessage(moderationCase: ModerationCase, embed: JsonObject): JsonObject {
  return {
    // Names never ping anyone.
    allowed_mentions: { parse: [] },
    embeds: [embed],
    components: moderationCaseButtons(moderationCase)
  };
}

/**
 * A city's name, linking to its screenshot's page on the viewer.
 */
function cityLink(screenshot: Pick<Screenshot, 'id' | 'cityName'>): string {
  return `[${escapeMarkdown(screenshot.cityName)}](${viewerBaseUrl}/city/${screenshot.id})`;
}

/**
 * A creator's name, or a placeholder when unnamed, linking to their page on the viewer.
 */
function creatorLink(creator: Pick<Creator, 'id' | 'creatorName'>): string {
  const name = creator.creatorName == null ? `Anonymous` : escapeMarkdown(creator.creatorName);

  return `[${name}](${viewerBaseUrl}/?creator=${creator.id})`;
}

/**
 * The fields of a showcased mod, as cached: a mod missing from the cache shows its ID only.
 */
function showcasedModFields(modId: number, mod: Mod | null): JsonObject[] {
  if (!mod) {
    return [{ name: `Mod`, value: `[${modId}](${paradoxModUrl(modId)})`, inline: true }];
  }

  const retiredMark = mod.isRetired ? ` (retired)` : '';

  return [
    {
      name: `Mod`,
      value: `[${escapeMarkdown(mod.name)}](${paradoxModUrl(modId)})${retiredMark}`,
      inline: true
    },
    { name: `Author`, value: escapeMarkdown(mod.authorName), inline: true }
  ];
}

/**
 * Escapes the characters Discord's Markdown reads in a name, so a name never breaks its link.
 */
function escapeMarkdown(text: string): string {
  return text.replaceAll(/[\\[\]()*_~`|]/gu, String.raw`\$&`);
}

/**
 * Formats a date as a Discord timestamp, which each reader sees in their own time zone.
 */
function discordTimestamp(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:f>`;
}
