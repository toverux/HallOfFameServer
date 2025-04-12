import { Inject, Provider } from '@nestjs/common';
import chalk from 'chalk';
import { oneLine, stripIndent } from 'common-tags';
import { CommandRunner, SubCommand } from 'nest-commander';
import { CreatorService, PrismaService } from '../../services';

@SubCommand({
  name: 'translate-creators',
  description: `Translate all creator names that have not been translated yet.`
})
export class AiTranslateCreatorsCommand extends CommandRunner {
  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(CreatorService)
  private readonly creatorService!: CreatorService;

  public override async run(): Promise<void> {
    const creators = await this.prisma.creator.findMany({
      where: { needsTranslation: true },
      select: { id: true, creatorId: true, creatorName: true }
    });

    console.info(chalk.bold`Found ${creators.length} creators to process.`);

    let translatedCount = 0;

    for (const creator of creators) {
      const result = await this.creatorService.updateCreatorNameTranslation(creator);

      if (!result.translated) {
        continue;
      }

      translatedCount++;

      console.info(
        oneLine`
        ${chalk.bold(result.creator.creatorName)} (${result.creator.creatorNameLocale})
        → ${result.creator.creatorNameLatinized}
        → ${result.creator.creatorNameTranslated}`
      );
    }

    console.info(
      stripIndent`
      ${chalk.bold`Done processing ${creators.length} creators.`}
      Translated ${translatedCount} creator names.`
    );
  }
}

export const aiTranslateCreatorsCommandProviders: Provider[] = [AiTranslateCreatorsCommand];
