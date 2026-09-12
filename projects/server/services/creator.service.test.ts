import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import type { Creator } from '#prisma-lib/client';
import type { CreatorId, HardwareId, IpAddress } from '../../shared/utils/branded-types';
import { nn } from '../../shared/utils/type-assertion';
import { createCreator } from '../testing/factories';
import { FakeAiTranslatorService } from '../testing/fakes';
import * as identifiers from '../testing/identifiers';
import { createServiceTestingModule } from '../testing/testing-module';
import { AiTranslatorService } from './ai-translator.service';
import { BackgroundTasksService } from './background-tasks.service';
import {
  CreatorNotFoundError,
  CreatorService,
  IncorrectCreatorIdError,
  InvalidCreatorIdError,
  InvalidCreatorNameError,
  type ModCreatorAuthorization
} from './creator.service';
import { PrismaService } from './prisma.service';

describe('CreatorService', () => {
  let testingModule: TestingModule;

  let creatorService: CreatorService;

  let prisma: PrismaService;

  beforeEach(async () => {
    testingModule = await createServiceTestingModule([
      CreatorService,
      BackgroundTasksService,
      { provide: AiTranslatorService, useValue: new FakeAiTranslatorService() }
    ]);

    creatorService = testingModule.get(CreatorService);
    prisma = testingModule.get(PrismaService);
  });

  afterEach(async () => {
    await testingModule.close();
  });

  describe('new accounts', () => {
    test.each(['paradox', 'local'] as const)(
      `creates an account for a new %s Creator ID, then authenticates it`,
      async creatorIdProvider => {
        const creator = await creatorService.authenticateCreator(
          newModAuthorization({ creatorIdProvider })
        );

        expect(creator).toMatchObject({
          creatorId: identifiers.unusedCreatorId,
          creatorIdProvider,
          creatorName: 'New Mayor',
          creatorNameSlug: 'new-mayor',
          allowCreatorIdReset: false,
          hwids: [identifiers.hwid1],
          ips: [identifiers.ip1]
        });

        expect(
          creatorService.authenticateCreator({
            kind: 'simple',
            creatorId: identifiers.unusedCreatorId,
            ip: identifiers.ip1
          })
        ).resolves.toEqual(creator);
      }
    );

    test(`creates an anonymous account without a name, next to other ones`, async () => {
      const anonymous = await createCreator(prisma, { creatorName: null });

      const creator = await creatorService.authenticateCreator(
        newModAuthorization({ creatorName: null })
      );

      expect(creator.id).not.toBe(anonymous.id);

      expect(creator).toMatchObject({
        creatorId: identifiers.unusedCreatorId,
        creatorName: null,
        creatorNameSlug: null
      });
    });
  });

  describe('Creator ID validation', () => {
    test.each([
      { kind: 'not a UUID', creatorId: 'toverux' as CreatorId },
      { kind: 'a UUID v1', creatorId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' as CreatorId },
      { kind: 'the nil UUID', creatorId: '00000000-0000-0000-0000-000000000000' as CreatorId }
    ])(`rejects a Creator ID that is $kind`, ({ creatorId }) => {
      expect(
        creatorService.authenticateCreator(newModAuthorization({ creatorId }))
      ).rejects.toThrow(InvalidCreatorIdError);

      expect(
        creatorService.authenticateCreator({ kind: 'simple', creatorId, ip: identifiers.ip1 })
      ).rejects.toThrow(`Invalid Creator ID "${creatorId}", an UUID v4 sequence was expected.`);
    });
  });

  describe('name and Creator ID conflicts', () => {
    test.each(['Mayor 1', 'mayor 1', 'MAYOR-1', "May'or 1"])(
      `rejects "%s" from another Creator ID, as it is claimed by "Mayor 1"`,
      async creatorName => {
        await createCreator(prisma);

        const authentication = creatorService.authenticateCreator(
          newModAuthorization({ creatorName })
        );

        expect(authentication).rejects.toThrow(IncorrectCreatorIdError);

        expect(authentication).rejects.toThrow(`Incorrect Creator ID for user "Mayor 1". `);
      }
    );

    test(`rejects renaming to a name another creator holds, keeping the old one`, async () => {
      const creator = await createCreator(prisma);

      await createCreator(prisma);

      const authentication = creatorService.authenticateCreator({
        ...modAuthorization(creator),
        creatorName: 'Mayor 2'
      });

      expect(authentication).rejects.toThrow(IncorrectCreatorIdError);

      expect(authentication).rejects.toThrow(`Incorrect Creator ID for user "Mayor 2". `);

      expect(creatorService.authenticateCreator(modAuthorization(creator))).resolves.toEqual(
        creator
      );
    });

    test(`renames the account to a name no one holds`, async () => {
      const creator = await createCreator(prisma);

      const renamed = await creatorService.authenticateCreator({
        ...modAuthorization(creator),
        creatorName: 'Mayor of Lakeland'
      });

      expect(renamed).toMatchObject({
        id: creator.id,
        creatorName: 'Mayor of Lakeland',
        creatorNameSlug: 'mayor-of-lakeland'
      });
    });
  });

  describe('Creator ID reset', () => {
    test(`adopts a new Creator ID and its provider when the reset is allowed`, async () => {
      const creator = await createCreator(prisma, {
        creatorIdProvider: 'local',
        allowCreatorIdReset: true
      });

      const reset = await creatorService.authenticateCreator({
        ...modAuthorization(creator),
        creatorId: identifiers.unusedCreatorId,
        creatorIdProvider: 'paradox'
      });

      expect(reset).toMatchObject({
        id: creator.id,
        creatorId: identifiers.unusedCreatorId,
        creatorIdProvider: 'paradox',
        allowCreatorIdReset: false
      });

      expect(
        creatorService.authenticateCreator({
          kind: 'simple',
          creatorId: creator.creatorId as CreatorId,
          ip: identifiers.ip1
        })
      ).rejects.toThrow(CreatorNotFoundError);
    });

    test(`allows a single reset, then rejects another Creator ID`, async () => {
      const creator = await createCreator(prisma, { allowCreatorIdReset: true });

      await creatorService.authenticateCreator({
        ...modAuthorization(creator),
        creatorId: identifiers.unusedCreatorId
      });

      expect(
        creatorService.authenticateCreator({
          ...modAuthorization(creator),
          creatorId: identifiers.otherUnusedCreatorId
        })
      ).rejects.toThrow(IncorrectCreatorIdError);
    });
  });

  describe('creator name validation', () => {
    test.each(['New \t  Mayor', ' New Mayor\t'])(
      `trims a new name and collapses its whitespace runs: %p`,
      creatorName => {
        expect(
          creatorService.authenticateCreator(newModAuthorization({ creatorName }))
        ).resolves.toMatchObject({ creatorName: 'New Mayor', creatorNameSlug: 'new-mayor' });
      }
    );

    test(`counts the length of a new name once its whitespace is collapsed`, () => {
      expect(
        creatorService.authenticateCreator(
          newModAuthorization({ creatorName: `Mayor${' '.repeat(20)}of Lakeland` })
        )
      ).resolves.toMatchObject({ creatorName: 'Mayor of Lakeland' });
    });

    test(`accepts a name of 25 characters`, () => {
      const creatorName = 'M'.repeat(25);

      expect(
        creatorService.authenticateCreator(newModAuthorization({ creatorName }))
      ).resolves.toMatchObject({ creatorName });
    });

    test(`rejects a new name of 26 characters`, () => {
      const creatorName = 'M'.repeat(26);

      expect(
        creatorService.authenticateCreator(newModAuthorization({ creatorName }))
      ).rejects.toThrow(
        `Creator Name "${creatorName}" is invalid, it must between 1 and 25 characters long.`
      );
    });

    test(`rejects renaming to 26 characters`, async () => {
      const creator = await createCreator(prisma);

      expect(
        creatorService.authenticateCreator({
          ...modAuthorization(creator),
          creatorName: 'M'.repeat(26)
        })
      ).rejects.toThrow(InvalidCreatorNameError);
    });

    test(`keeps authenticating a legacy name that no longer validates`, async () => {
      const creator = await createCreator(prisma, { creatorName: 'M'.repeat(30) });

      expect(creatorService.authenticateCreator(modAuthorization(creator))).resolves.toEqual(
        creator
      );
    });
  });

  describe('IP and hardware ID history', () => {
    let creator: Creator;

    beforeEach(async () => {
      creator = await createCreator(prisma, {
        ips: [identifiers.ip1, identifiers.ip2, identifiers.ip3],
        hwids: [identifiers.hwid1, identifiers.hwid2, identifiers.hwid3]
      });
    });

    const cases = [
      {
        kind: 'a new',
        ip: identifiers.ip4,
        hwid: identifiers.hwid4,
        ips: [identifiers.ip4, identifiers.ip1, identifiers.ip2],
        hwids: [identifiers.hwid4, identifiers.hwid1, identifiers.hwid2]
      },
      {
        kind: 'a known',
        ip: identifiers.ip3,
        hwid: identifiers.hwid3,
        ips: [identifiers.ip3, identifiers.ip1, identifiers.ip2],
        hwids: [identifiers.hwid3, identifiers.hwid1, identifiers.hwid2]
      }
    ];

    test.each(cases)(
      `records $kind IP and hardware ID as the most recent, keeping 3`,
      async ({ ip, hwid, ips, hwids }) => {
        const updated = await creatorService.authenticateCreator({
          ...modAuthorization(creator),
          ip,
          hwid
        });

        expect(updated.ips).toEqual(ips);
        expect(updated.hwids).toEqual(hwids);
      }
    );

    test.each(cases)(
      `records $kind IP the same way from a Creator ID alone, keeping hardware IDs`,
      async ({ ip, ips }) => {
        const updated = await creatorService.authenticateCreator({
          kind: 'simple',
          creatorId: creator.creatorId as CreatorId,
          ip
        });

        expect(updated.ips).toEqual(ips);
        expect(updated.hwids).toEqual([identifiers.hwid1, identifiers.hwid2, identifiers.hwid3]);
      }
    );
  });
});

describe('CreatorService.getCreatorNameSlug', () => {
  test.each([
    { name: 'Mayor 1', slug: 'mayor-1' },
    { name: 'New \t  Mayor', slug: 'new-mayor' },
    { name: 'Big--City', slug: 'big-city' },
    { name: ' -Mayor- ', slug: 'mayor' },
    { name: "O'Brien", slug: 'obrien' },
    { name: 'O’Brien', slug: 'obrien' },
    { name: 'ÉLODIE', slug: 'élodie' },
    { name: '東京市長', slug: '東京市長' }
  ])(`slugs "$name" as "$slug"`, ({ name, slug }) => {
    expect(CreatorService.getCreatorNameSlug(name)).toBe(slug);
  });

  test.each([null, '', '   '])(`has no slug for %p`, name => {
    expect(CreatorService.getCreatorNameSlug(name)).toBeNull();
  });
});

/**
 * A first authentication from the mod, with a Creator ID no one holds yet.
 */
function newModAuthorization(
  overrides: Partial<ModCreatorAuthorization> = {}
): ModCreatorAuthorization {
  return {
    kind: 'mod',
    creatorName: 'New Mayor',
    creatorId: identifiers.unusedCreatorId,
    creatorIdProvider: 'paradox',
    hwid: identifiers.hwid1,
    ip: identifiers.ip1,
    ...overrides
  };
}

/**
 * The authentication the mod sends for an existing Creator, from their most recent IP and hardware
 * ID.
 */
function modAuthorization(creator: Creator): ModCreatorAuthorization {
  return {
    kind: 'mod',
    creatorName: creator.creatorName,
    creatorId: creator.creatorId as CreatorId,
    creatorIdProvider: creator.creatorIdProvider,
    hwid: nn(creator.hwids[0]) as HardwareId,
    ip: nn(creator.ips[0]) as IpAddress
  };
}
