import { Inject, type Provider } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import chalk from 'chalk';
import { CommandRunner, SubCommand } from 'nest-commander';
import { iconsole } from '../../../../shared/iconsole';
import { PrismaService } from '../../../services';

@SubCommand({
  name: 'merge',
  arguments: '<target> <duplicate>',
  description: `Merge two creator accounts, by database ID, Creator ID, or Creator Name.`
})
export class CreatorMergeCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [CreatorMergeCommand];

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  public override async run(args: [string, string]): Promise<void> {
    const [target, duplicate] = args;

    await this.prisma.$transaction(prisma => this.runTransaction(prisma, target, duplicate));
  }

  private async runTransaction(
    prisma: Prisma.TransactionClient,
    target: string,
    duplicate: string
  ): Promise<void> {
    const duplicateCreator = await prisma.creator.findFirst({
      where: {
        // biome-ignore lint/style/useNamingConvention: prisma
        OR: [{ id: duplicate }, { creatorId: duplicate }, { creatorName: duplicate }]
      }
    });

    if (!duplicateCreator) {
      throw `Creator ${duplicate} not found.`;
    }

    const targetCreator = await prisma.creator.findFirst({
      where: {
        // biome-ignore lint/style/useNamingConvention: prisma
        OR: [{ id: target }, { creatorId: target }, { creatorName: target }]
      }
    });

    if (!targetCreator) {
      throw `Creator ${target} not found.`;
    }

    iconsole.info(chalk.bold(`Merging`), duplicateCreator, chalk.bold(`into`), targetCreator);

    const { count: updatedScreenshots } = await prisma.screenshot.updateMany({
      where: { creatorId: duplicateCreator.id },
      data: { creatorId: targetCreator.id }
    });

    iconsole.info(chalk.bold(`Updated ${updatedScreenshots} screenshots.`));

    const { count: updatedFavorites } = await prisma.favorite.updateMany({
      where: { creatorId: duplicateCreator.id },
      data: { creatorId: targetCreator.id }
    });

    iconsole.info(chalk.bold(`Updated ${updatedFavorites} favorites.`));

    const { count: updatedViews } = await prisma.view.updateMany({
      where: { creatorId: duplicateCreator.id },
      data: { creatorId: targetCreator.id }
    });

    iconsole.info(chalk.bold(`Updated ${updatedViews} views.`));

    await prisma.creator.delete({
      where: { id: duplicateCreator.id }
    });

    iconsole.info(chalk.bold(`Deleted duplicate creator ${duplicateCreator.id}.`));
  }
}
