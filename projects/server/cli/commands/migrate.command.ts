import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Provider } from '@nestjs/common';
import chalk from 'chalk';
import { type ClientSession, type Db, MongoClient } from 'mongodb';
import { Command, CommandRunner } from 'nest-commander';
import type { Migration } from '../../../../prisma/migrations/types';
import { iconsole } from '../../../shared/iconsole';
import { nn } from '../../../shared/utils/type-assertion';
import { config } from '../../config';

@Command({
  name: 'migrate',
  description: `Run pending database migrations from the prisma/migrations directory.`
})
export class MigrateCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [MigrateCommand];

  private readonly migrationsPath = path.join(import.meta.dir, '../../../../prisma/migrations');

  private readonly client = new MongoClient(config.databaseUrl);

  private db: Db | undefined;

  public override async run(): Promise<void> {
    try {
      await this.connect();

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

      const session = this.client.startSession();

      try {
        await session.withTransaction(async () => {
          for (const migrationFile of pendingMigrations) {
            iconsole.info(`⌛ Running migration ${chalk.bold(migrationFile)}...`);

            await this.runMigration(migrationFile, session);

            iconsole.info(`✅ Ran migration ${chalk.bold(migrationFile)}`);
          }
        });

        iconsole.info(chalk.bold.greenBright(`All migrations completed successfully.`));
      } finally {
        await session.endSession();
      }
    } catch (error) {
      iconsole.error(
        chalk.bold.redBright(
          `Error running migrations (no changes have been persisted to the database).`
        )
      );

      throw error;
    } finally {
      await this.disconnect();
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
      .filter(file => file != 'types.ts' && file.endsWith('.ts'))
      .sort();
  }

  /**
   * Connect to MongoDB using the native client.
   */
  private async connect(): Promise<void> {
    await this.client.connect();

    this.db = this.client.db();
  }

  /**
   * Disconnect from MongoDB.
   */
  private async disconnect(): Promise<void> {
    await this.client.close();

    this.db = undefined;
  }

  /**
   * Get all pending migrations.
   */
  private async getPendingMigrations(): Promise<string[]> {
    nn.assert(this.db);

    const migrationFiles = await this.getMigrationFiles();

    const executedMigrations = await this.db
      .collection('migrations')
      .find({}, { projection: { name: 1 } })
      .sort({ name: 1 })
      .toArray();

    const executedMigrationNames = executedMigrations.map(migration => migration.name);

    return migrationFiles.filter(file => !executedMigrationNames.includes(file));
  }

  /**
   * Run a single migration from a file path.
   */
  private async runMigration(migrationFile: string, session: ClientSession): Promise<void> {
    nn.assert(this.db);

    const migrationFilePath = path.join(this.migrationsPath, migrationFile);

    // Import the migration file.
    const migrationModule = await import(migrationFilePath);

    // Check module format.
    const migration: Migration | undefined = migrationModule.migration;

    if (!migration) {
      throw `Migration ${migrationFile} does not have an exported "migration" object.`;
    }

    // Run the migration.
    await migration.run(this.db, session);

    // Record the migration
    await this.db.collection('migrations').insertOne({
      name: migrationFile,
      executedAt: new Date()
    });
  }
}
