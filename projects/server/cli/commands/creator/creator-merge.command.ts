import { Inject, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { CommandRunner, SubCommand } from 'nest-commander';
import type { Prisma } from '#prisma-lib/client';
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
        OR: [{ id: duplicate }, { creatorId: duplicate }, { creatorName: duplicate }]
      }
    });

    if (!duplicateCreator) {
      throw `Creator ${duplicate} not found.`;
    }

    const targetCreator = await prisma.creator.findFirst({
      where: {
        OR: [{ id: target }, { creatorId: target }, { creatorName: target }]
      }
    });

    if (!targetCreator) {
      throw `Creator ${target} not found.`;
    }

    // Merging an account into itself would end by deleting it, with all its records.
    if (targetCreator.id == duplicateCreator.id) {
      throw `Creator ${target} and ${duplicate} are the same account.`;
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

    // A day both creators played keeps the target's record, the cascade deletes the duplicate's.
    const targetActivities = await prisma.creatorActivity.findMany({
      select: { day: true },
      where: { creatorId: targetCreator.id }
    });

    const { count: updatedActivities } = await prisma.creatorActivity.updateMany({
      where: {
        creatorId: duplicateCreator.id,
        day: { notIn: targetActivities.map(activity => activity.day) }
      },
      data: { creatorId: targetCreator.id }
    });

    iconsole.info(chalk.bold(`Updated ${updatedActivities} activity days.`));

    // The account dates from the player's first one, so a merged veteran is no newcomer.
    if (duplicateCreator.createdAt < targetCreator.createdAt) {
      await prisma.creator.update({
        where: { id: targetCreator.id },
        data: { createdAt: duplicateCreator.createdAt }
      });

      iconsole.info(
        chalk.bold(`Dated the account from ${duplicateCreator.createdAt.toISOString()}.`)
      );
    }

    await prisma.creator.delete({
      where: { id: duplicateCreator.id }
    });

    iconsole.info(chalk.bold(`Deleted duplicate creator ${duplicateCreator.id}.`));
  }
}
