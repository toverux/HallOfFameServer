import { Inject, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { CommandRunner, SubCommand } from 'nest-commander';
import { iconsole } from '../../../../shared/iconsole';
import { config } from '../../../config';
import { ModerationCaseService } from '../../../services';

@SubCommand({
  name: 'post-cases',
  description: `Post the pending moderation cases to Discord now, as the daily batch does.`
})
export class ModeratePostCasesCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [ModeratePostCasesCommand];

  @Inject(ModerationCaseService)
  private readonly moderationCases!: ModerationCaseService;

  public override async run(): Promise<void> {
    if (!config.discord.isEnabled) {
      iconsole.error(`Discord is disabled (HOF_DISCORD_BOT_TOKEN), nothing was posted.`);

      return;
    }

    const postedCount = await this.moderationCases.postPendingCases();

    iconsole.info(chalk.bold(`Posted ${postedCount} moderation cases to Discord.`));
  }
}
