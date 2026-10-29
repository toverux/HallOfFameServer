import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { oneLine } from 'common-tags';
import type { ModerationCaseOutcome, Screenshot } from '#prisma-lib/client';
import { unreachable } from '../../shared/utils/type-assertion';
import { StandardError } from '../common/standard-error';
import { BanService } from './ban.service';
import { ModerationCaseService, type ModerationCaseSettler } from './moderation-case.service';
import { PrismaService } from './prisma.service';
import { ScreenshotService } from './screenshot.service';

export type ReportAction = 'approve' | 'delete' | 'ban';

/**
 * The moderator's actions on each kind of item, each settling the item's pending case, whichever
 * surface it comes from.
 */
@Injectable()
export class ModerationService {
  private static readonly reportOutcomes = {
    approve: 'approved',
    delete: 'deleted',
    ban: 'banned'
  } as const satisfies Record<ReportAction, ModerationCaseOutcome>;

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(BanService)
  private readonly banService!: BanService;

  @Inject(ScreenshotService)
  private readonly screenshotService!: ScreenshotService;

  @Inject(ModerationCaseService)
  private readonly moderationCases!: ModerationCaseService;

  /**
   * Settles a reported screenshot: approves it, which clears the report and makes it unreportable,
   * deletes it, or bans its creator and deletes it.
   * A screenshot reported before cases existed has none, and settles all the same.
   *
   * @throws {ModerationCaseClaimedError} When another surface is settling the case.
   */
  public async settleReport(
    screenshotId: Screenshot['id'],
    action: ReportAction,
    settler: ModerationCaseSettler
  ): Promise<void> {
    const run = (): Promise<void> => this.runReportAction(screenshotId, action);

    const moderationCase = await this.moderationCases.findUnsettledCase('report', screenshotId);

    if (!moderationCase) {
      await run();

      return;
    }

    const outcome = ModerationService.reportOutcomes[action];

    if (!(await this.moderationCases.settle(moderationCase.id, outcome, settler, run))) {
      throw new ModerationCaseClaimedError();
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
}

export class ModerationCaseClaimedError extends StandardError {
  public override httpErrorType = ConflictException;

  public constructor() {
    super(`This item is being settled elsewhere, or was just settled.`);
  }
}
