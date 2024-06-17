import {
    Injectable,
    Logger,
    type OnApplicationBootstrap
} from '@nestjs/common';
import { type Prisma, PrismaClient } from '@prisma/client';
import { filesize } from 'filesize';

const prismaConfig = {
    log: [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'info' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'query' }
    ]
} as const satisfies Prisma.PrismaClientOptions;

@Injectable()
export class PrismaService
    extends PrismaClient<typeof prismaConfig>
    implements OnApplicationBootstrap
{
    private readonly logger = new Logger(PrismaService.name);

    public constructor() {
        super(prismaConfig);

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

        const { totalSize } = await this.$runCommandRaw({ dbStats: 1 });

        const totalSizeStr = filesize(Number(totalSize), { round: 0 });

        this.logger.log(`Connected to MongoDB, DB size: ${totalSizeStr}.`);
    }
}
