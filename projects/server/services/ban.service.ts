import { Inject, Injectable, Logger } from '@nestjs/common';
import { Ban, Creator } from '@prisma/client';
import { oneLine } from 'common-tags';
import { LRUCache } from 'lru-cache';
import { HardwareID, StandardError } from '../common';
import { config } from '../config';
import { PrismaService } from './prisma.service';

/**
 * Service to manage Creator and Hardware ID bans.
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
     * The key is the hwid or Creator ID, and the value is either
     *  - `false` if the hwid or creator is *not* banned,
     *  - A {@link BanError} if the hwid or creator is banned.
     *
     * @see checkBanCache
     */
    private readonly banCache = new LRUCache<
        HardwareID | Creator['id'],
        BanError | false
    >({
        max: 200,
        ttl: 5 * 60 * 1000
    });

    /**
     * Checks whether the given hardware ID and/or creator are banned.
     *
     * @throws BanError If the hwid or creator is banned.
     */
    public async ensureNotBanned(
        hwid: HardwareID,
        creatorId: Creator['id']
    ): Promise<void> {
        if (this.checkBanCache(hwid) && this.checkBanCache(creatorId)) {
            return;
        }

        const bans = await this.prisma.ban.findMany({
            // biome-ignore lint/style/useNamingConvention: prisma
            where: { OR: [{ hwid }, { creatorId }] }
        });

        // If there are multiple bans, prefer using a creator-based ban.
        const ban = bans.find(ban => !!ban.creatorId) ?? bans[0];

        // If the ban is creator-based, throw a banned creator error.
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

        // Otherwise, throw a banned hardware ID error.
        if (ban) {
            throw this.cacheBanError(
                hwid,
                new BannedHardwareIdError(hwid, ban, config.supportContact)
            );
        }

        // If there is no ban, cache it too.
        this.banCache.set(hwid, false);
        this.banCache.set(creatorId, false);
    }

    /**
     * Bans a creator and all hardware IDs historically associated with them.
     */
    public async banCreator(
        creator: Pick<Creator, 'id' | 'creatorName' | 'hwids'>,
        reason: string
    ): Promise<void> {
        this.banCache.delete(creator.id);

        const reasonFormatted = BanService.fmtReason(reason);

        await this.prisma.ban.createMany({
            data: [
                { creatorId: creator.id, reason: reasonFormatted },
                ...creator.hwids.map(hwid => ({
                    hwid,
                    creatorId: creator.id,
                    reason: reasonFormatted
                }))
            ]
        });

        this.logger.warn(oneLine`
            Banned creator #${creator.id} "${creator.creatorName}"
            and Hardware IDs ${creator.hwids.join(', ')}
            for: ${reasonFormatted}.`);
    }

    /**
     * Checks whether the given hardware ID or creator ID is banned or not,
     * using the ban cache {@link banCache}.
     *
     * @throws BanError If the hwid or creator is banned.
     *
     * @returns `true` if the hwid or creator is *NOT* banned,
     *          `false` if the status must be verified with the database.
     */
    private checkBanCache(
        hwidOrCreatorId: HardwareID | Creator['id']
    ): boolean {
        const cachedError = this.banCache.get(hwidOrCreatorId);

        if (cachedError) {
            throw cachedError;
        }

        return cachedError === false;
    }

    /**
     * Returns the given ban error after having cached it in {@link banCache}.
     */
    private cacheBanError(
        hwidOrCreatorId: HardwareID | Creator['id'],
        error: BanError
    ): BanError {
        this.banCache.set(hwidOrCreatorId, error);

        return error;
    }

    /**
     * Formats a ban reason for consistency.
     * Removes leading/trailing whitespace, normalizes whitespace, and ensures
     * the reason does not end with a period.
     */
    private static fmtReason(reason: string): string {
        const formatted = reason.trim().replace(/\s+/g, ' ').toLowerCase();

        return formatted.endsWith('.') ? formatted.slice(0, -1) : formatted;
    }
}

export abstract class BanError extends StandardError {}

export class BannedHardwareIdError extends BanError {
    public override kind = 'forbidden' as const;

    public constructor(
        public readonly hardwareId: HardwareID,
        public readonly ban: Pick<Ban, 'reason' | 'bannedAt'>,
        public readonly supportContact: string
    ) {
        super(oneLine`
            You are banned for the following reason: ${ban.reason}
            (${ban.bannedAt.toLocaleString()} UTC).
            Please contact support to appeal (${supportContact}),
            communicate identifier ${hardwareId}.`);
    }
}

export class BannedCreatorError extends BanError {
    public override kind = 'forbidden' as const;

    public constructor(
        public readonly ban: Pick<Ban, 'reason' | 'bannedAt'>,
        public readonly creator: Pick<Creator, 'creatorName'>,
        public readonly supportContact: string
    ) {
        super(oneLine`
            Creator "${creator.creatorName}" is banned
            for the following reason: ${ban.reason}
            (${ban.bannedAt.toLocaleString()} UTC).
            Please contact support to appeal (${supportContact}).`);
    }
}
