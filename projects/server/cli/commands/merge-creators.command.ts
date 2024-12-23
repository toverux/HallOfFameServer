import { Inject, Provider } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import chalk from 'chalk';
import { Command, CommandRunner } from 'nest-commander';
import { PrismaService } from '../../services';

@Command({
    name: 'merge-creators',
    arguments: '<duplicate> <target>',
    description: `Merges two creator accounts.`
})
class MergeCreatorsCommand extends CommandRunner {
    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    public override async run(args: [string, string]): Promise<void> {
        const [duplicate, target] = args;

        await this.prisma.$transaction(prisma => this.runTransaction(prisma, duplicate, target));
    }

    private async runTransaction(
        prisma: Prisma.TransactionClient,
        duplicate: string,
        target: string
    ): Promise<void> {
        const duplicateCreator = await prisma.creator.findFirst({
            where: {
                // biome-ignore lint/style/useNamingConvention: prisma
                OR: [{ id: duplicate }, { creatorId: duplicate }, { creatorName: duplicate }]
            }
        });

        if (!duplicateCreator) {
            // biome-ignore lint/style/useThrowOnlyError: normal pattern w/Commander
            throw `Creator ${duplicate} not found.`;
        }

        const targetCreator = await prisma.creator.findFirst({
            where: {
                // biome-ignore lint/style/useNamingConvention: prisma
                OR: [{ id: target }, { creatorId: target }, { creatorName: target }]
            }
        });

        if (!targetCreator) {
            // biome-ignore lint/style/useThrowOnlyError: normal pattern w/Commander
            throw `Creator ${target} not found.`;
        }

        console.info(chalk.bold`Merging`, duplicateCreator, chalk.bold`into`, targetCreator);

        const { count: updatedScreenshots } = await prisma.screenshot.updateMany({
            where: { creatorId: duplicateCreator.id },
            data: { creatorId: targetCreator.id }
        });

        console.info(chalk.bold`Updated ${updatedScreenshots} screenshots.`);

        const { count: updatedFavorites } = await prisma.favorite.updateMany({
            where: { creatorId: duplicateCreator.id },
            data: { creatorId: targetCreator.id }
        });

        console.info(chalk.bold`Updated ${updatedFavorites} favorites.`);

        const { count: updatedViews } = await prisma.view.updateMany({
            where: { creatorId: duplicateCreator.id },
            data: { creatorId: targetCreator.id }
        });

        console.info(chalk.bold`Updated ${updatedViews} views.`);

        await prisma.creator.delete({
            where: { id: duplicateCreator.id }
        });

        console.info(chalk.bold`Deleted duplicate creator ${duplicateCreator.id}.`);
    }
}

export const mergeCreatorsCommandProviders: Provider[] = [MergeCreatorsCommand];
