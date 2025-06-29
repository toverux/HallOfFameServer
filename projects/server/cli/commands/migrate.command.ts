import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Inject, type Provider } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import chalk from 'chalk';
import { Command, CommandRunner } from 'nest-commander';
import type { MigrationModule } from '../../../../prisma/migrations';
import { iconsole } from '../../iconsole';
import { PrismaService } from '../../services';

@Command({
  name: 'migrate',
  description: `Run pending database migrations from the prisma/migrations directory.`
})
export class MigrateCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [MigrateCommand];

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  private readonly migrationsPath = path.join(import.meta.dir, '../../../../prisma/migrations');

  public override async run(): Promise<void> {
    const pendingMigrations = await this.getPendingMigrations();

    if (!pendingMigrations.length) {
      iconsole.info(chalk.bold.greenBright(`No pending migrations to run.`));
      return;
    }

    iconsole.info(
      chalk.bold(
        `Found ${pendingMigrations.length} pending migrations: ${pendingMigrations.join(', ')}.`
      )
    );

    try {
      await this.prisma.$transaction(async tx => {
        for (const migrationFile of pendingMigrations) {
          iconsole.info(`⌛ Running migration ${migrationFile}...`);

          await this.runMigration(migrationFile, tx);

          iconsole.info(`✅ Ran migration ${migrationFile}.`);
        }
      });

      iconsole.info(chalk.bold.greenBright(`All migrations completed successfully.`));
    } catch (error) {
      iconsole.error(
        chalk.bold.redBright(
          `Error running migrations (no changes have been persisted to the database).`
        )
      );

      throw error;
    }
  }

  /**
   * Get all migration files from the migrations directory.
   */
  private async getMigrationFiles(): Promise<string[]> {
    // Ensure the migrations directory exists
    if (!(await fs.exists(this.migrationsPath))) {
      await fs.mkdir(this.migrationsPath, { recursive: true });
    }

    // Get all .ts files in the migrations directory
    return (await fs.readdir(this.migrationsPath))
      .filter(file => file != 'index.ts' && file.endsWith('.ts'))
      .sort();
  }

  /**
   * Get all pending migrations.
   */
  private async getPendingMigrations(): Promise<string[]> {
    const migrationFiles = await this.getMigrationFiles();

    const executedMigrations = await this.prisma.migration.findMany({ orderBy: { name: 'asc' } });

    const executedMigrationNames = executedMigrations.map(migration => migration.name);

    return migrationFiles.filter(file => !executedMigrationNames.includes(file));
  }

  /**
   * Run all pending migrations
   */
  private async runMigration(
    migrationFile: string,
    prisma: Prisma.TransactionClient
  ): Promise<void> {
    const migrationFilePath = path.join(this.migrationsPath, migrationFile);

    // Import the migration file
    const migration: MigrationModule = await import(migrationFilePath);

    // Run the migration
    await migration.run(prisma);

    // Record the migration
    await prisma.migration.create({
      data: { name: migrationFile }
    });
  }
}
