import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import type { HardwareId, IpAddress } from '../../shared/utils/branded-types';
import { config } from '../config';
import { createBan, createCreator } from '../testing/factories';
import { createServiceTestingModule } from '../testing/testing-module';
import { BannedCreatorError, BannedError, BanService } from './ban.service';
import { PrismaService } from './prisma.service';

const ip = '198.51.100.1' as IpAddress;

const otherIp = '198.51.100.2' as IpAddress;

const hwid = 'f00dfeedf00dfeedf00dfeedf00dfeedf00dfeed' as HardwareId;

const otherHwid = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff' as HardwareId;

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
      await createBan(prisma, { ip: otherIp });
      await createBan(prisma, { hwid: otherHwid });

      expect(banService.ensureNotBanned(ip, hwid)).resolves.toBeUndefined();
    });

    test(`rejects a banned IP`, async () => {
      await createBan(prisma, { ip, reason: 'spamming', bannedAt });

      const check = banService.ensureNotBanned(ip, undefined);

      expect(check).rejects.toThrow(BannedError);

      expect(check).rejects.toThrow(
        `You are banned for the following reason: spamming (${bannedAt.toLocaleString()} UTC). ` +
          `Please contact support to appeal (${config.supportContact}), ` +
          `communicate your IP address "${ip}".`
      );
    });

    test(`rejects a banned hardware ID, even from an IP that is not banned`, async () => {
      await createBan(prisma, { hwid, reason: 'spamming', bannedAt });

      const check = banService.ensureNotBanned(ip, hwid);

      expect(check).rejects.toThrow(BannedError);

      expect(check).rejects.toThrow(
        `communicate your identifier "${hwid}" and IP address "${ip}".`
      );
    });

    test(`prefers a matching ban with a creator, naming the creator`, async () => {
      const creator = await createCreator(prisma);

      await createBan(prisma, { ip, reason: 'spamming' });
      await createBan(prisma, { hwid, creatorId: creator.id, reason: 'cheating' });

      const check = banService.ensureNotBanned(ip, hwid);

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
      await createBan(prisma, { ip });

      expect(banService.ensureNotBanned(ip, undefined)).rejects.toThrow(BannedError);

      await prisma.ban.deleteMany();

      expect(banService.ensureNotBanned(ip, undefined)).rejects.toThrow(BannedError);
    });

    test(`keeps rejecting a cached creator ban after the ban is lifted`, async () => {
      const creator = await createCreator(prisma);

      await createBan(prisma, { creatorId: creator.id });

      expect(banService.ensureCreatorNotBanned(creator)).rejects.toThrow(BannedCreatorError);

      await prisma.ban.deleteMany();

      expect(banService.ensureCreatorNotBanned(creator)).rejects.toThrow(BannedCreatorError);
    });

    test(`keeps passing an IP and hardware ID cached as not banned`, async () => {
      await banService.ensureNotBanned(ip, hwid);

      await createBan(prisma, { ip });
      await createBan(prisma, { hwid });

      expect(banService.ensureNotBanned(ip, hwid)).resolves.toBeUndefined();
    });

    test(`keeps passing a creator cached as not banned`, async () => {
      const creator = await createCreator(prisma);

      await banService.ensureCreatorNotBanned(creator);

      await createBan(prisma, { creatorId: creator.id });

      expect(banService.ensureCreatorNotBanned(creator)).resolves.toBeUndefined();
    });

    test(`checks the database for a hardware ID it has not seen yet`, async () => {
      await banService.ensureNotBanned(ip, undefined);

      await createBan(prisma, { hwid });

      expect(banService.ensureNotBanned(ip, hwid)).rejects.toThrow(BannedError);
    });
  });

  describe('banCreator', () => {
    test(`bans the creator and every IP and hardware ID they used`, async () => {
      const creator = await createCreator(prisma, {
        ips: [ip, otherIp],
        hwids: [hwid, otherHwid]
      });

      await banService.banCreator(creator, 'cheating');

      expect(banService.ensureCreatorNotBanned(creator)).rejects.toThrow(BannedCreatorError);

      expect(banService.ensureNotBanned(otherIp, undefined)).rejects.toThrow(BannedCreatorError);

      // From an unknown IP, so only the hardware ID matches.
      const unknownIp = '192.0.2.1' as IpAddress;

      expect(banService.ensureNotBanned(unknownIp, otherHwid)).rejects.toThrow(BannedCreatorError);
    });

    test(`overrides the creator, IPs, and hardware IDs cached as not banned`, async () => {
      const creator = await createCreator(prisma, { ips: [ip], hwids: [hwid] });

      await banService.ensureCreatorNotBanned(creator);
      await banService.ensureNotBanned(ip, hwid);

      await banService.banCreator(creator, 'cheating');

      expect(banService.ensureCreatorNotBanned(creator)).rejects.toThrow(BannedCreatorError);
      expect(banService.ensureNotBanned(ip, hwid)).rejects.toThrow(BannedCreatorError);
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
