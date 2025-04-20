import { Inject, Provider } from '@nestjs/common';
import chalk from 'chalk';
import { CommandRunner, SubCommand } from 'nest-commander';
import { PrismaService } from '../../../services';

@SubCommand({
  name: 'delete',
  arguments: '<id>',
  description: `Delete a creator from the database and all related entities.`
})
export class CreatorDeleteCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [CreatorDeleteCommand];

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  public override async run(args: [string]): Promise<void> {
    const [id] = args;

    await this.prisma.creator.delete({ where: { id } });

    console.info(chalk.bold`Creator ${id} deleted successfully!`);
  }
}
