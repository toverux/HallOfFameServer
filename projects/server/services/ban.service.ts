import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { Ban, Creator } from '@prisma/client';
import { oneLine } from 'common-tags';
import { LRUCache } from 'lru-cache';
import { HardwareID, IPAddress, StandardError } from '../common';
import { config } from '../config';
import { PrismaService } from './prisma.service';

/**
 * Service to manage Creator ID, IP address and Hardware ID bans.
 */
@Injectable()
export class BanService {
    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    private readonly logger = new Logger(BanService.name);

    /**
     * Cache to store the ban status of hardware IDs and creators.
     * Entries expire after 5 minutes.
     *
     * The key is the IP address, Hardware ID, Creator ID, and the value is either:
     *  - `false` if the IP, hwid or creator is *not* banned,
     *  - A {@link BanError} if the IP, hwid or creator is banned.
     *
     * @see checkBanCache
     */
    private readonly banCache = new LRUCache<
        HardwareID | IPAddress | Creator['id'],
        BanError | false
    >({
        max: 200,
        ttl: 5 * 60 * 1000
    });

    /**
     * Ensures the given IP and Hardware ID are not banned.
     *
     * @throws BannedError If the IP or Hardware ID is banned.
     */
    public async ensureNotBanned(ip: IPAddress, hwid: HardwareID): Promise<void> {
        if (this.checkBanCache(ip) && this.checkBanCache(hwid)) {
            return;
        }

        const bans = await this.prisma.ban.findMany({
            // biome-ignore lint/style/useNamingConvention: prisma
            where: { OR: [{ ip }, { hwid }] }
        });

        // If there are multiple bans matching, prefer using one with a Creator ID so we can provide
        // a more specific error message.
        const ban = bans.find(ban => !!ban.creatorId) ?? bans[0];

        // If there is a creator-based ban, throw a specific error.
        if (ban?.creatorId) {
            const creator = await this.prisma.creator.findUnique({
                where: { id: ban.creatorId },
                select: { id: true, creatorName: true }
            });

            if (creator) {
                throw this.cacheBanError(
                    creator.id,
                    new BannedCreatorError(ban, creator, config.supportContact)
                );
            }
        }

        // Otherwise, throw the non-creator-based ban error.
        if (ban) {
            const error = new BannedError(ip, hwid, ban, config.supportContact);

            this.cacheBanError(ip, error);
            this.cacheBanError(hwid, error);

            throw error;
        }

        // If there is no ban, cache it too.
        this.banCache.set(ip, false);
        this.banCache.set(hwid, false);
    }

    /**
     * Ensures the creator is not banned.
     *
     * @throws BannedCreatorError If the creator is banned.
     */
    public async ensureCreatorNotBanned(
        creator: Pick<Creator, 'id' | 'creatorName'>
    ): Promise<void> {
        if (this.checkBanCache(creator.id)) {
            return;
        }

        const ban = await this.prisma.ban.findFirst({
            where: { creatorId: creator.id }
        });

        if (ban) {
            throw this.cacheBanError(
                creator.id,
                new BannedCreatorError(ban, creator, config.supportContact)
            );
        }

        this.banCache.set(creator.id, false);
    }

    /**
     * Bans a creator and all hardware IDs historically associated with them.
     */
    public async banCreator(
        creator: Pick<Creator, 'id' | 'creatorName' | 'ips' | 'hwids'>,
        reason: string
    ): Promise<void> {
        for (const ip of [creator.id, ...creator.ips, ...creator.hwids]) {
            this.banCache.delete(ip);
        }

        const reasonFormatted = BanService.fmtReason(reason);

        await this.prisma.ban.createMany({
            data: [
                { creatorId: creator.id, reason: reasonFormatted },
                ...creator.ips.map(ip => ({
                    ip,
                    creatorId: creator.id,
                    reason: reasonFormatted
                })),
                ...creator.hwids.map(hwid => ({
                    hwid,
                    creatorId: creator.id,
                    reason: reasonFormatted
                }))
            ]
        });

        this.logger.warn(oneLine`
            Banned creator #${creator.id} "${creator.creatorName ?? '<anonymous>'}"
            as well as IP addresses [${creator.ips.join(', ')}]
            and Hardware IDs [${creator.hwids.join(', ')}]
            for: ${reasonFormatted}.`);
    }

    /**
     * Checks whether the given hardware ID or creator ID is banned or not, using the ban cache
     * {@link banCache}.
     *
     * @throws BanError If the IP, hwid or creator is banned.
     *
     * @returns `true` if the IP, hwid or creator is *NOT* banned,
     *          `false` if the status must be verified with the database.
     */
    private checkBanCache(cacheKey: IPAddress | HardwareID | Creator['id']): boolean {
        const cachedError = this.banCache.get(cacheKey);

        if (cachedError) {
            throw cachedError;
        }

        return cachedError === false;
    }

    /**
     * Returns the given ban error after having cached it in {@link banCache}.
     */
    private cacheBanError(
        cacheKey: IPAddress | HardwareID | Creator['id'],
        error: BanError
    ): BanError {
        this.banCache.set(cacheKey, error);

        return error;
    }

    /**
     * Formats a ban reason for consistency.
     * Removes leading/trailing whitespace, normalizes whitespace, and ensures the reason does not
     * end with a period.
     */
    private static fmtReason(reason: string): string {
        const formatted = reason.trim().replace(/\s+/g, ' ').toLowerCase();

        return formatted.endsWith('.') ? formatted.slice(0, -1) : formatted;
    }
}

export abstract class BanError extends StandardError {}

export class BannedError extends BanError {
    public override httpErrorType = ForbiddenException;

    public constructor(
        public readonly ip: IPAddress,
        public readonly hardwareId: HardwareID,
        public readonly ban: Pick<Ban, 'reason' | 'bannedAt'>,
        public readonly supportContact: string
    ) {
        super(oneLine`
            You are banned for the following reason: ${ban.reason}
            (${ban.bannedAt.toLocaleString()} UTC).
            Please contact support to appeal (${supportContact}),
            communicate identifier "${hardwareId}" and IP address "${ip}".`);
    }
}

export class BannedCreatorError extends BanError {
    public override httpErrorType = ForbiddenException;

    public constructor(
        public readonly ban: Pick<Ban, 'reason' | 'bannedAt'>,
        public readonly creator: Pick<Creator, 'creatorName'>,
        public readonly supportContact: string
    ) {
        super(oneLine`
            Creator "${creator.creatorName ?? '<anonymous>'}" is banned
            for the following reason: ${ban.reason}
            (${ban.bannedAt.toLocaleString()} UTC).
            Please contact support to appeal (${supportContact}).`);
    }
}
