import { Inject, Injectable } from '@nestjs/common';
import type { ModerationCase, ModerationCaseKind } from '#prisma-lib/client';
import type { JsonObject } from '../../shared/utils/json';
import { config } from '../config';
import { BackgroundTasksService } from './background-tasks.service';
import { DiscordService } from './discord.service';
import {
  type ModerationCaseButton,
  moderationCaseActions,
  parseModerationCaseButton
} from './moderation-case-actions';
import { ModerationCaseService } from './moderation-case.service';
import { ModerationService } from './moderation.service';

/**
 * A click on a button of a case's message, as Discord sends it.
 */
export interface ButtonClick {
  readonly userId: string;
  readonly customId: string;
  /**
   * Lets the server send follow-up messages to the clicker for a while after it answers.
   */
  readonly interactionToken: string;
}

/**
 * Answers the moderator's clicks on the buttons of a case's message.
 * An action takes the case's settle claim before answering, so of two clicks only one acts, then
 * runs in the background, past Discord's three-second deadline to answer.
 */
@Injectable()
export class DiscordInteractionService {
  /**
   * Discord's interaction response types this service answers with.
   */
  private static readonly responseType = {
    channelMessage: 4,
    deferredUpdateMessage: 6
  } as const;

  /**
   * Discord's message flag that shows a message to the clicker only.
   */
  private static readonly ephemeralFlag = 64;

  private static readonly noCaseReply = `This button matches no moderation case.`;

  private static readonly alreadyHandledReply = `This case was already handled.`;

  /**
   * The reply to a click on a case that went moot, by the case's kind.
   */
  private static readonly mootReplies = {
    report: `This screenshot no longer exists, the case is closed.`,
    showcased_mod: `This screenshot no longer showcases this mod, the case is closed.`,
    near_duplicate: `A screenshot of this pair no longer exists, the case is closed.`
  } as const satisfies Record<ModerationCaseKind, string>;

  @Inject(BackgroundTasksService)
  private readonly backgroundTasks!: BackgroundTasksService;

  @Inject(DiscordService)
  private readonly discord!: DiscordService;

  @Inject(ModerationCaseService)
  private readonly moderationCases!: ModerationCaseService;

  @Inject(ModerationService)
  private readonly moderation!: ModerationService;

  /**
   * @returns The interaction response to send to Discord.
   */
  public async handleButtonClick(click: ButtonClick): Promise<JsonObject> {
    if (!config.discord.moderatorIds.includes(click.userId)) {
      return this.ephemeral(`You are not allowed to moderate Hall of Fame.`);
    }

    const button = parseModerationCaseButton(click.customId);

    if (!button) {
      return this.ephemeral(DiscordInteractionService.noCaseReply);
    }

    const moderationCase = await this.moderationCases.findCase(button.caseId);

    if (moderationCase?.kind != moderationCaseActions[button.action].kind) {
      return this.ephemeral(DiscordInteractionService.noCaseReply);
    }

    if (moderationCase.outcome) {
      // The message outlived its case, as when its deletion failed.
      if (moderationCase.discordMessageId) {
        this.moderationCases.deleteMessage(moderationCase.id, moderationCase.discordMessageId);
      }

      return this.ephemeral(DiscordInteractionService.alreadyHandledReply);
    }

    if (!(await this.moderationCases.isLive(moderationCase))) {
      return this.ephemeral(
        (await this.moderationCases.settleAsMoot(moderationCase.id))
          ? DiscordInteractionService.mootReplies[moderationCase.kind]
          : DiscordInteractionService.alreadyHandledReply
      );
    }

    if (!(await this.moderationCases.claimSettle(moderationCase.id))) {
      return this.ephemeral(DiscordInteractionService.alreadyHandledReply);
    }

    this.backgroundTasks.run(
      `Failed to settle moderation case #${moderationCase.id} from Discord.`,
      () => this.settleClaimed(moderationCase, button, click)
    );

    return { type: DiscordInteractionService.responseType.deferredUpdateMessage };
  }

  /**
   * Runs the button's action on the claimed case, telling the clicker when it fails.
   */
  private async settleClaimed(
    moderationCase: ModerationCase,
    button: ModerationCaseButton,
    click: ButtonClick
  ): Promise<void> {
    try {
      await this.moderation.settleClaimedCase(moderationCase, button.action, {
        surface: 'discord',
        discordUserId: click.userId
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      this.backgroundTasks.run(
        `Failed to tell the moderator that moderation case #${moderationCase.id} failed.`,
        () =>
          this.discord.createFollowupMessage(click.interactionToken, {
            content: `${moderationCaseActions[button.action].label} failed: ${reason}`,
            flags: DiscordInteractionService.ephemeralFlag
          })
      );

      throw error;
    }
  }

  /**
   * A response message only the clicker sees.
   */
  private ephemeral(content: string): JsonObject {
    return {
      type: DiscordInteractionService.responseType.channelMessage,
      data: { content, flags: DiscordInteractionService.ephemeralFlag }
    };
  }
}
