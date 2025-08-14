import { Inject, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { oneLine, stripIndent } from 'common-tags';
import { CommandRunner, SubCommand } from 'nest-commander';
import { iconsole } from '../../../../shared/iconsole';
import { CreatorService, PrismaService } from '../../../services';

@SubCommand({
  name: 'translate',
  description: `Translate all creator names that have not been translated yet.`
})
export class CreatorTranslateCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [CreatorTranslateCommand];

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(CreatorService)
  private readonly creatorService!: CreatorService;

  public override async run(): Promise<void> {
    const creators = await this.prisma.creator.findMany({
      where: { needsTranslation: true },
      select: { id: true, creatorId: true, creatorName: true }
    });

    iconsole.info(chalk.bold(`Found ${creators.length} creators to process.`));

    let translatedCount = 0;

    for (const creator of creators) {
      const result = await this.creatorService.updateCreatorNameTranslation(creator);

      if (!result.translated) {
        continue;
      }

      translatedCount++;

      iconsole.info(
        oneLine`
        ${chalk.bold(result.creator.creatorName)} (${result.creator.creatorNameLocale})
        → ${result.creator.creatorNameLatinized}
        → ${result.creator.creatorNameTranslated}`
      );
    }

    iconsole.info(
      stripIndent`
      ${chalk.bold(`Done processing ${creators.length} creators.`)}
      Translated ${translatedCount} creator names.`
    );
  }
}
