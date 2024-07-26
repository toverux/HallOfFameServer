import { Inject, Injectable, Logger } from '@nestjs/common';
import { Ban, Creator } from '@prisma/client';
import { oneLine } from 'common-tags';
import { LRUCache } from 'lru-cache';
import { type IPAddress, StandardError } from '../common';
import { ConfigService } from './config.service';
import { PrismaService } from './prisma.service';

/**
 * Service to manage Creator and IP address bans.
 */
@Injectable()
export class BanService {
    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    @Inject(ConfigService)
    private readonly config!: ConfigService;

    private readonly logger = new Logger(BanService.name);

    /**
     * Cache to store the ban status of IP addresses and creators.
     * Entries expire after 5 minutes.
     *
     * The key is the IP address or creator ID, and the value is either
     *  - `false` if the IP address or creator is *not* banned,
     *  - A {@link BanError} if the IP address or creator is banned.
     *
     * @see checkBanCache
     */
    private readonly banCache = new LRUCache<string, BanError | false>({
        max: 200,
        ttl: 5 * 60 * 1000
    });

    /**
     * Ensures the IP address is not banned.
     *
     * @throws BannedIpAddressError If the IP address is banned.
     * @throws BannedCreatorError If the ban was a general ban on a creator.
     */
    public async ensureIpAddressNotBanned(ipAddress: IPAddress): Promise<void> {
        if (this.checkBanCache(ipAddress)) {
            return;
        }

        const ban = await this.prisma.ban.findFirst({
            where: { ipAddress }
        });

        if (ban?.creatorId) {
            const creator = await this.prisma.creator.findUnique({
                where: { id: ban.creatorId },
                select: { id: true, creatorName: true }
            });

            if (creator) {
                throw this.cacheBanError(
                    creator.id,
                    new BannedCreatorError(
                        ban,
                        creator,
                        this.config.supportContact
                    )
                );
            }
        }

        if (ban) {
            throw this.cacheBanError(
                ipAddress,
                new BannedIpAddressError(ban, this.config.supportContact)
            );
        }

        this.banCache.set(ipAddress, false);
    }

    /**
     * Bans a specific IP address.
     */
    public async banIp(ipAddress: IPAddress, reason: string): Promise<void> {
        this.banCache.delete(ipAddress);

        const reasonFormatted = BanService.fmtReason(reason);

        await this.prisma.ban.create({
            data: { ipAddress, reason: reasonFormatted }
        });

        this.logger.warn(
            `Banned IP address "${ipAddress}" for: ${reasonFormatted}.`
        );
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
                new BannedCreatorError(ban, creator, this.config.supportContact)
            );
        }

        this.banCache.set(creator.id, false);
    }

    /**
     * Bans a creator and all IP addresses historically associated with them.
     */
    public async banCreator(
        creator: Pick<Creator, 'id' | 'creatorName' | 'ipAddresses'>,
        reason: string
    ): Promise<void> {
        this.banCache.delete(creator.id);

        const reasonFormatted = BanService.fmtReason(reason);

        await this.prisma.ban.createMany({
            data: [
                { creatorId: creator.id, reason: reasonFormatted },
                ...creator.ipAddresses.map(ipAddress => ({
                    ipAddress,
                    creatorId: creator.id,
                    reason: reasonFormatted
                }))
            ]
        });

        this.logger.warn(oneLine`
            Banned creator #${creator.id} "${creator.creatorName}"
            and IP addresses ${creator.ipAddresses.join(', ')}
            for: ${reasonFormatted}.`);
    }

    /**
     * Checks whether the given IP address or creator ID is banned or not, using
     * the ban cache {@link banCache}.
     *
     * @throws BanError If the IP address or creator is banned.
     *
     * @returns `true` if the IP address or creator is *NOT* banned,
     *          `false` if the status must be verified with the database.
     */
    private checkBanCache(ipOrCreatorId: IPAddress | Creator['id']): boolean {
        const cachedError = this.banCache.get(ipOrCreatorId);

        if (cachedError) {
            throw cachedError;
        }

        return cachedError === false;
    }

    /**
     * Returns the given ban error after having cached it in {@link banCache}.
     */
    private cacheBanError(
        ipOrCreatorId: IPAddress | Creator['id'],
        error: BanError
    ): BanError {
        this.banCache.set(ipOrCreatorId, error);

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

export class BannedIpAddressError extends BanError {
    public override kind = 'forbidden' as const;

    public constructor(
        public readonly ban: Ban,
        public readonly supportContact: string
    ) {
        super(oneLine`
            Your IP address "${ban.ipAddress}" is banned
            for the following reason: ${ban.reason}
            (${ban.bannedAt.toLocaleString()} UTC).
            Please contact support to appeal (${supportContact}).`);
    }
}

export class BannedCreatorError extends BanError {
    public override kind = 'forbidden' as const;

    public constructor(
        public readonly ban: Ban,
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
