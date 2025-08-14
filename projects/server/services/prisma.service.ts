import assert from 'node:assert/strict';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Prisma, PrismaClient } from '@prisma/client';
import { filesize } from 'filesize';
import { config } from '../config';

// Remap all events to be emitted as events (for custom handling with `$on()`) rather than being
// printed on stdout/stderr directly by Prisma.
const logDefinitions = [
  { emit: 'event', level: 'error' },
  { emit: 'event', level: 'info' },
  { emit: 'event', level: 'warn' },
  { emit: 'event', level: 'query' }
] satisfies Prisma.LogDefinition[];

const prismaOptions = {
  log: logDefinitions,
  datasourceUrl: config.databaseUrl,
  errorFormat: 'pretty'
} satisfies Prisma.PrismaClientOptions;

@Injectable()
export class PrismaService
  extends PrismaClient<typeof prismaOptions, (typeof logDefinitions)[number]['level']>
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(PrismaService.name);

  public constructor() {
    super(prismaOptions);

    this.$on('error', ({ target, message }) => {
      // You might be surprised that 'debug' level is used, but this is because all errors we
      // get there are also thrown into the caller stack, so there already is proper error
      // handling in place, so logging as error is redundant and rethrowing would break the
      // aforementioned classic error handling.
      this.logger.debug(`Error on ${target}: ${message}`);
    });

    this.$on('warn', ({ target, message }) => {
      this.logger.warn(`Warning on ${target}: ${message}`);
    });

    this.$on('info', ({ target, message }) => {
      this.logger.log(`Info on ${target}: ${message}`);
    });

    this.$on('query', ({ duration, query }) => {
      this.logger.debug(`Query (${duration}ms): ${query}`);
    });
  }

  public async onApplicationBootstrap(): Promise<void> {
    this.logger.log(`Connecting to MongoDB...`);

    await this.$connect();

    // Now we'll run a "random" command just to check that the connection is working, $connect()
    // does not do that, it just tries to open a connection, but if there is, for example, no
    // MongoDB server running, it will happily return.

    const stats = await this.$runCommandRaw({ dbStats: 1 });

    assert(stats.ok, 'dbStats command returned ok: false.');

    const totalSizeStr = filesize(Number(stats.totalSize), { round: 0 });

    this.logger.log(`Connected to MongoDB, database ${stats.db}, size: ${totalSizeStr}.`);
  }
}
