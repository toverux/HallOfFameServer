import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import type { Creator } from '#prisma-lib/client';
import { iconsole } from '../../../../shared/iconsole';
import { PrismaService } from '../../../services/prisma.service';
import { createCreator } from '../../../testing/factories';
import { createServiceTestingModule } from '../../../testing/testing-module';
import { CreatorMergeCommand } from './creator-merge.command';

describe('creator merge', () => {
  let testingModule: TestingModule;

  let prisma: PrismaService;

  let command: CreatorMergeCommand;

  let logInfo: Mock<typeof iconsole.info>;

  beforeEach(async () => {
    testingModule = await createServiceTestingModule(CreatorMergeCommand.providers());
    prisma = testingModule.get(PrismaService);
    command = testingModule.get(CreatorMergeCommand);
    logInfo = spyOn(iconsole, 'info').mockReturnValue(void 0);
  });

  afterEach(async () => {
    logInfo.mockRestore();
    await testingModule.close();
  });

  test(`dates the target's account from the older duplicate's creation`, async () => {
    const target = await createCreator(prisma, { createdAt: new Date('2026-03-01T00:00:00Z') });
    const duplicate = await createCreator(prisma, { createdAt: new Date('2025-06-01T00:00:00Z') });

    await command.run([target.id, duplicate.id]);

    expect(await findCreatedAt(target)).toEqual(new Date('2025-06-01T00:00:00Z'));
  });

  test(`keeps the target's creation date when the duplicate is newer`, async () => {
    const target = await createCreator(prisma, { createdAt: new Date('2025-06-01T00:00:00Z') });
    const duplicate = await createCreator(prisma, { createdAt: new Date('2026-03-01T00:00:00Z') });

    await command.run([target.id, duplicate.id]);

    expect(await findCreatedAt(target)).toEqual(new Date('2025-06-01T00:00:00Z'));
  });

  test(`refuses to merge a creator into itself`, async () => {
    const creator = await createCreator(prisma);

    expect(command.run([creator.id, creator.id])).rejects.toBe(
      `Creator ${creator.id} and ${creator.id} are the same account.`
    );

    expect(await prisma.creator.count()).toBe(1);
  });

  // Asserted with toEqual, as Bun's toMatchObject passes on any two dates.
  async function findCreatedAt(creator: Pick<Creator, 'id'>): Promise<Date> {
    const { createdAt } = await prisma.creator.findUniqueOrThrow({
      select: { createdAt: true },
      where: { id: creator.id }
    });

    return createdAt;
  }
});
