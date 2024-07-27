import assert from 'node:assert/strict';
import {
    Injectable,
    Logger,
    type OnApplicationBootstrap
} from '@nestjs/common';
import { type Prisma, PrismaClient } from '@prisma/client';
import { filesize } from 'filesize';
import { ConfigService } from './config.service'; // Remap all events to be emitted as events (for custom handling with `$on()`)

// Remap all events to be emitted as events (for custom handling with `$on()`)
// rather than being printed on stdout/stderr directly by Prisma.
const logDefinitions = [
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'info' },
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'query' }
] satisfies Prisma.LogDefinition[];

@Injectable()
export class PrismaService
    extends PrismaClient<{ log: typeof logDefinitions; datasourceUrl: string }>
    implements OnApplicationBootstrap
{
    private readonly logger = new Logger(PrismaService.name);

    public constructor(config: ConfigService) {
        super({
            log: logDefinitions,
            datasourceUrl: config.databaseUrl
        });

        this.$on('error', ({ target, message }) => {
            this.logger.error(`Error on ${target}: ${message}`);

            // There should be no need to rethrow here, first we don't have
            // the error object, and if an error was raised it should be thrown
            // in the caller stack.
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

        // Now we'll run a "random" command just to check that the connection
        // is working, $connect() does not do that, it just tries to open a
        // connection, but if there is, for example, no MongoDB server running,
        // it will happily return.

        const stats = await this.$runCommandRaw({ dbStats: 1 });

        assert(stats.ok, 'dbStats command returned ok: false.');

        // totalSize is normally returned by dbStats, but not on Atlas.
        // Note that this is the total size of the database occupied on disk,
        // not just the raw data, and it includes space that's reserved but not
        // used yet.
        const totalSize = Number(stats.storageSize) + Number(stats.indexSize);

        const totalSizeStr = filesize(totalSize, { round: 0 });

        this.logger.log(`Connected to MongoDB, DB size: ${totalSizeStr}.`);
    }
}
