import { Body, Controller, HttpCode, HttpStatus, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { JsonObject } from '../../../shared/utils/json';
import { DiscordSignatureGuard } from '../../guards';
import { ZodParsePipe } from '../../pipes';
import { DiscordInteractionService } from '../../services';

@Controller('discord')
@UseGuards(DiscordSignatureGuard)
export class DiscordController {
  /**
   * Discord's types of the interactions this application receives, and of the PING's answer.
   */
  private static readonly interactionType = { ping: 1, messageComponent: 3, pong: 1 } as const;

  private static readonly userSchema = z.looseObject({ id: z.string() });

  /**
   * The interactions this application receives: Discord's PING, and clicks on the buttons of the
   * moderation channel's messages, from a guild member or, in a DM, from a user.
   *
   * @see interactions
   */
  private static readonly interactionSchema = z.discriminatedUnion('type', [
    z.looseObject({ type: z.literal(DiscordController.interactionType.ping) }),
    z.looseObject({
      type: z.literal(DiscordController.interactionType.messageComponent),
      token: z.string(),
      member: z.looseObject({ user: DiscordController.userSchema }).optional(),
      user: DiscordController.userSchema.optional(),
      data: z.looseObject({ custom_id: z.string() })
    })
  ]);

  @Inject(DiscordInteractionService)
  private readonly discordInteractions!: DiscordInteractionService;

  /**
   * Discord's Interactions Endpoint URL, which Discord validates with a PING when it is set.
   */
  @Post('interactions')
  @HttpCode(HttpStatus.OK)
  public interactions(
    @Body(new ZodParsePipe(DiscordController.interactionSchema))
    interaction: z.infer<typeof DiscordController.interactionSchema>
  ): Promise<JsonObject> {
    if (interaction.type == DiscordController.interactionType.ping) {
      return Promise.resolve({ type: DiscordController.interactionType.pong });
    }

    // A click carries one or the other; without either, it matches no moderator.
    const user = interaction.member?.user ?? interaction.user;

    return this.discordInteractions.handleButtonClick({
      userId: user?.id ?? '',
      customId: interaction.data.custom_id,
      interactionToken: interaction.token
    });
  }
}
