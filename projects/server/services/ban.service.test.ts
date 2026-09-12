import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import { config } from '../config';
import { createBan, createCreator } from '../testing/factories';
import * as identifiers from '../testing/identifiers';
import { createServiceTestingModule } from '../testing/testing-module';
import { BannedCreatorError, BannedError, BanService } from './ban.service';
import { PrismaService } from './prisma.service';

const bannedAt = new Date('2026-03-14T15:09:26Z');

describe('BanService', () => {
  let testingModule: TestingModule;

  let banService: BanService;

  let prisma: PrismaService;

  // A fresh module per test, as the ban cache lives in the BanService instance.
  beforeEach(async () => {
    testingModule = await createServiceTestingModule([BanService]);
    banService = testingModule.get(BanService);
    prisma = testingModule.get(PrismaService);
  });

  afterEach(async () => {
    await testingModule.close();
  });

  describe('ensureNotBanned', () => {
    test(`passes an IP and a hardware ID matching no ban`, async () => {
      await createBan(prisma, { ip: identifiers.ip2 });
      await createBan(prisma, { hwid: identifiers.hwid2 });

      expect(
        banService.ensureNotBanned(identifiers.ip1, identifiers.hwid1)
      ).resolves.toBeUndefined();
    });

    test(`rejects a banned IP`, async () => {
      await createBan(prisma, { ip: identifiers.ip1, reason: 'spamming', bannedAt });

      const check = banService.ensureNotBanned(identifiers.ip1, undefined);

      expect(check).rejects.toThrow(BannedError);

      expect(check).rejects.toThrow(
        `You are banned for the following reason: spamming (${bannedAt.toLocaleString()} UTC). ` +
          `Please contact support to appeal (${config.supportContact}), ` +
          `communicate your IP address "${identifiers.ip1}".`
      );
    });

    test(`rejects a banned hardware ID, even from an IP that is not banned`, async () => {
      await createBan(prisma, { hwid: identifiers.hwid1, reason: 'spamming', bannedAt });

      const check = banService.ensureNotBanned(identifiers.ip1, identifiers.hwid1);

      expect(check).rejects.toThrow(BannedError);

      expect(check).rejects.toThrow(
        `communicate your identifier "${identifiers.hwid1}" and IP address "${identifiers.ip1}".`
      );
    });

    test(`prefers a matching ban with a creator, naming the creator`, async () => {
      const creator = await createCreator(prisma);

      await createBan(prisma, { ip: identifiers.ip1, reason: 'spamming' });
      await createBan(prisma, {
        hwid: identifiers.hwid1,
        creatorId: creator.id,
        reason: 'cheating'
      });

      const check = banService.ensureNotBanned(identifiers.ip1, identifiers.hwid1);

      expect(check).rejects.toThrow(BannedCreatorError);

      expect(check).rejects.toThrow(
        `Creator "${creator.creatorName}" is banned for the following reason: cheating (`
      );
    });
  });

  describe('ensureCreatorNotBanned', () => {
    test(`passes a creator that is not banned`, async () => {
      const creator = await createCreator(prisma);
      const bannedCreator = await createCreator(prisma);

      await createBan(prisma, { creatorId: bannedCreator.id });

      expect(banService.ensureCreatorNotBanned(creator)).resolves.toBeUndefined();
    });

    test(`rejects a banned creator, naming them`, async () => {
      const creator = await createCreator(prisma);

      await createBan(prisma, { creatorId: creator.id, reason: 'cheating', bannedAt });

      const check = banService.ensureCreatorNotBanned(creator);

      expect(check).rejects.toThrow(BannedCreatorError);

      expect(check).rejects.toThrow(
        `Creator "${creator.creatorName}" is banned for the following reason: cheating ` +
          `(${bannedAt.toLocaleString()} UTC). ` +
          `Please contact support to appeal (${config.supportContact}).`
      );
    });
  });

  describe('ban cache', () => {
    test(`keeps rejecting a cached IP ban after the ban is lifted`, async () => {
      await createBan(prisma, { ip: identifiers.ip1 });

      expect(banService.ensureNotBanned(identifiers.ip1, undefined)).rejects.toThrow(BannedError);

      await prisma.ban.deleteMany();

      expect(banService.ensureNotBanned(identifiers.ip1, undefined)).rejects.toThrow(BannedError);
    });

    test(`keeps rejecting a cached creator ban after the ban is lifted`, async () => {
      const creator = await createCreator(prisma);

      await createBan(prisma, { creatorId: creator.id });

      expect(banService.ensureCreatorNotBanned(creator)).rejects.toThrow(BannedCreatorError);

      await prisma.ban.deleteMany();

      expect(banService.ensureCreatorNotBanned(creator)).rejects.toThrow(BannedCreatorError);
    });

    test(`keeps passing an IP and hardware ID cached as not banned`, async () => {
      await banService.ensureNotBanned(identifiers.ip1, identifiers.hwid1);

      await createBan(prisma, { ip: identifiers.ip1 });
      await createBan(prisma, { hwid: identifiers.hwid1 });

      expect(
        banService.ensureNotBanned(identifiers.ip1, identifiers.hwid1)
      ).resolves.toBeUndefined();
    });

    test(`keeps passing a creator cached as not banned`, async () => {
      const creator = await createCreator(prisma);

      await banService.ensureCreatorNotBanned(creator);

      await createBan(prisma, { creatorId: creator.id });

      expect(banService.ensureCreatorNotBanned(creator)).resolves.toBeUndefined();
    });

    test(`checks the database for a hardware ID it has not seen yet`, async () => {
      await banService.ensureNotBanned(identifiers.ip1, undefined);

      await createBan(prisma, { hwid: identifiers.hwid1 });

      expect(banService.ensureNotBanned(identifiers.ip1, identifiers.hwid1)).rejects.toThrow(
        BannedError
      );
    });
  });

  describe('banCreator', () => {
    test(`bans the creator and every IP and hardware ID they used`, async () => {
      const creator = await createCreator(prisma, {
        ips: [identifiers.ip1, identifiers.ip2],
        hwids: [identifiers.hwid1, identifiers.hwid2]
      });

      await banService.banCreator(creator, 'cheating');

      expect(banService.ensureCreatorNotBanned(creator)).rejects.toThrow(BannedCreatorError);

      expect(banService.ensureNotBanned(identifiers.ip2, undefined)).rejects.toThrow(
        BannedCreatorError
      );

      // From an IP they never used, so only the hardware ID matches.
      expect(banService.ensureNotBanned(identifiers.ip3, identifiers.hwid2)).rejects.toThrow(
        BannedCreatorError
      );
    });

    test(`overrides the creator, IPs, and hardware IDs cached as not banned`, async () => {
      const creator = await createCreator(prisma, {
        ips: [identifiers.ip1],
        hwids: [identifiers.hwid1]
      });

      await banService.ensureCreatorNotBanned(creator);
      await banService.ensureNotBanned(identifiers.ip1, identifiers.hwid1);

      await banService.banCreator(creator, 'cheating');

      expect(banService.ensureCreatorNotBanned(creator)).rejects.toThrow(BannedCreatorError);
      expect(banService.ensureNotBanned(identifiers.ip1, identifiers.hwid1)).rejects.toThrow(
        BannedCreatorError
      );
    });

    test(`formats the reason trimmed, single-spaced, lowercase, no final period`, async () => {
      const creator = await createCreator(prisma);

      await banService.banCreator(creator, '  Uploading\n  Inappropriate   Content.  ');

      expect(banService.ensureCreatorNotBanned(creator)).rejects.toThrow(
        `is banned for the following reason: uploading inappropriate content (`
      );
    });
  });
});
