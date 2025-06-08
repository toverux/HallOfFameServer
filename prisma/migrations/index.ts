import { Prisma } from '@prisma/client';

export interface MigrationModule {
  readonly run: MigrationRunFn;
}

export type MigrationRunFn = (prisma: Prisma.TransactionClient) => Promise<void>;
