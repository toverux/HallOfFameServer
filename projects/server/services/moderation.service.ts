import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { oneLine } from 'common-tags';
import type { ModerationCase, Screenshot } from '#prisma-lib/client';
import { nn, unreachable } from '../../shared/utils/type-assertion';
import { StandardError } from '../common/standard-error';
import { BanService } from './ban.service';
import { type ModerationCaseAction, moderationCaseActions } from './moderation-case-actions';
import {
  ModerationCaseService,
  type ModerationCaseSettler,
  type UnsettledCaseQuery
} from './moderation-case.service';
import { PrismaService } from './prisma.service';
import { ScreenshotMergingService } from './screenshot-merging.service';
import { ScreenshotSimilarityDetectorService } from './screenshot-similarity-detector.service';
import { ScreenshotService } from './screenshot.service';

export type ReportAction = 'approve' | 'delete' | 'ban';

export type ShowcaseAction = 'accept' | 'remove';

export type NearDuplicateAction = 'allow' | 'keepA' | 'keepB';

/**
 * A near-duplicate pair, oriented by `orientPair()`.
 */
export interface NearDuplicatePair {
  /**
   * The older screenshot.
   */
  readonly a: Screenshot['id'];
  readonly b: Screenshot['id'];
}

/**
 * The moderator's actions on each kind of item, each settling the item's pending case, whichever
 * surface it comes from.
 */
@Injectable()
export class ModerationService {
  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(BanService)
  private readonly banService!: BanService;

  @Inject(ScreenshotService)
  private readonly screenshotService!: ScreenshotService;

  @Inject(ModerationCaseService)
  private readonly moderationCases!: ModerationCaseService;

  @Inject(ScreenshotMergingService)
  private readonly screenshotMerging!: ScreenshotMergingService;

  @Inject(ScreenshotSimilarityDetectorService)
  private readonly screenshotSimilarityDetector!: ScreenshotSimilarityDetectorService;

  /**
   * Settles a reported screenshot: approves it, which clears the report and makes it unreportable,
   * deletes it, or bans its creator and deletes it.
   * A screenshot reported before cases existed has none, and settles all the same.
   *
   * @throws {ModerationCaseClaimedError} When another surface is settling the case.
   */
  public settleReport(
    screenshotId: Screenshot['id'],
    action: ReportAction,
    settler: ModerationCaseSettler
  ): Promise<void> {
    return this.settleItem({ kind: 'report', screenshotId }, action, settler, () =>
      this.runReportAction(screenshotId, action)
    );
  }

  /**
   * Settles the mod a screenshot showcases: accepts it, which validates the showcase, or removes it
   * from the screenshot.
   * A showcase made before cases existed has none, and settles all the same.
   *
   * @throws {ModerationCaseClaimedError} When another surface is settling the case.
   */
  public settleShowcase(
    screenshot: Pick<Screenshot, 'id'> & { readonly showcasedModId: number },
    action: ShowcaseAction,
    settler: ModerationCaseSettler
  ): Promise<void> {
    return this.settleItem(
      {
        kind: 'showcased_mod',
        screenshotId: screenshot.id,
        showcasedModId: screenshot.showcasedModId
      },
      action,
      settler,
      () => this.runShowcaseAction(screenshot.id, screenshot.showcasedModId, action)
    );
  }

  /**
   * Settles a near-duplicate pair: allows both screenshots, which stops the pair being reported as
   * similar again, or keeps one, merging the other into it.
   * A pair found before cases existed has none, and settles all the same.
   *
   * @throws {ModerationCaseClaimedError} When another surface is settling the case.
   */
  public settleNearDuplicate(
    pair: NearDuplicatePair,
    action: NearDuplicateAction,
    settler: ModerationCaseSettler
  ): Promise<void> {
    return this.settleItem(
      { kind: 'near_duplicate', screenshotId: pair.b, pairedScreenshotId: pair.a },
      action,
      settler,
      () => this.runNearDuplicateAction(pair, action)
    );
  }

  /**
   * Settles a case whose settle claim the caller holds, as a button does after answering Discord,
   * with an action of the case's kind.
   * A failed action releases the claim and rethrows, leaving the case pending.
   */
  public settleClaimedCase(
    moderationCase: ModerationCase,
    action: ModerationCaseAction,
    settler: ModerationCaseSettler
  ): Promise<void> {
    return this.moderationCases.settleClaimed(
      moderationCase.id,
      moderationCaseActions[action].outcome,
      settler,
      () => this.runCaseAction(moderationCase, action)
    );
  }

  /**
   * Runs an item's action, settling its pending case when it has one.
   */
  private async settleItem(
    item: UnsettledCaseQuery,
    action: ModerationCaseAction,
    settler: ModerationCaseSettler,
    run: () => Promise<void>
  ): Promise<void> {
    const moderationCase = await this.moderationCases.findUnsettledCase(item);

    if (!moderationCase) {
      await run();

      return;
    }

    const { outcome } = moderationCaseActions[action];

    if (!(await this.moderationCases.settle(moderationCase.id, outcome, settler, run))) {
      throw new ModerationCaseClaimedError();
    }
  }

  private runCaseAction(
    moderationCase: ModerationCase,
    action: ModerationCaseAction
  ): Promise<void> {
    switch (action) {
      case 'approve':
      case 'delete':
      case 'ban': {
        return this.runReportAction(moderationCase.screenshotId, action);
      }
      case 'accept':
      case 'remove': {
        return this.runShowcaseAction(
          moderationCase.screenshotId,
          nn(moderationCase.showcasedModId),
          action
        );
      }
      case 'allow':
      case 'keepA':
      case 'keepB': {
        return this.runNearDuplicateAction(
          { a: nn(moderationCase.pairedScreenshotId), b: moderationCase.screenshotId },
          action
        );
      }
      default: {
        return unreachable(action);
      }
    }
  }

  private async runReportAction(
    screenshotId: Screenshot['id'],
    action: ReportAction
  ): Promise<void> {
    switch (action) {
      case 'approve': {
        await this.screenshotService.unmarkReported(screenshotId);
        break;
      }
      case 'delete': {
        await this.screenshotService.deleteScreenshot(screenshotId);
        break;
      }
      case 'ban': {
        const screenshot = await this.prisma.screenshot.findUniqueOrThrow({
          where: { id: screenshotId },
          include: { creator: true }
        });

        await this.banService.banCreator(
          screenshot.creator,
          oneLine`
          one or more screenshots for city "${screenshot.cityName}" was
          reported and judged to be inappropriate by our moderation team`
        );

        await this.screenshotService.deleteScreenshot(screenshotId);
        break;
      }
      default: {
        unreachable(action);
      }
    }
  }

  /**
   * Updates the screenshot only while it showcases the mod the moderator judged, so an edit racing
   * the decision never sees it applied to another mod.
   */
  private async runShowcaseAction(
    screenshotId: Screenshot['id'],
    showcasedModId: number,
    action: ShowcaseAction
  ): Promise<void> {
    const update = await this.prisma.screenshot.updateMany({
      where: { id: screenshotId, showcasedModId },
      data:
        action == 'accept'
          ? { isShowcasedModValidated: true }
          : { showcasedModId: null, isShowcasedModValidated: false }
    });

    if (!update.count) {
      throw new Error(`Screenshot #${screenshotId} no longer showcases mod #${showcasedModId}.`);
    }
  }

  /**
   * A Keep deletes the other screenshot, whose other pending cases go moot through the deletion,
   * this one spared as its settle holds the claim.
   */
  private async runNearDuplicateAction(
    pair: NearDuplicatePair,
    action: NearDuplicateAction
  ): Promise<void> {
    switch (action) {
      case 'allow': {
        await this.screenshotSimilarityDetector.allowScreenshotSimilarity(pair.a, pair.b);
        break;
      }
      case 'keepA': {
        await this.screenshotMerging.mergeScreenshots(pair.a, [pair.b]);
        break;
      }
      case 'keepB': {
        await this.screenshotMerging.mergeScreenshots(pair.b, [pair.a]);
        break;
      }
      default: {
        unreachable(action);
      }
    }
  }
}

export class ModerationCaseClaimedError extends StandardError {
  public override httpErrorType = ConflictException;

  public constructor() {
    super(`This item is being settled elsewhere, or was just settled.`);
  }
}
