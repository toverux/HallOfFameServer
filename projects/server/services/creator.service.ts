import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Creator } from '@prisma/client';
import Bun from 'bun';
import { oneLine } from 'common-tags';
import { LRUCache } from 'lru-cache';
import { JSONObject, StandardError } from '../common';
import { BanService } from './ban.service';
import { PrismaService } from './prisma.service';

/**
 * Service to manage authenticate and manage Creators.
 */
@Injectable()
export class CreatorService {
    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    @Inject(BanService)
    private readonly banService!: BanService;

    private readonly logger = new Logger(CreatorService.name);

    private readonly maxFailedLoginAttempts = 4;

    private readonly failedLoginAttempts = new LRUCache<string, number>({
        max: 200
    });

    public async getOrCreateCreator(
        creatorId: string,
        creatorName: string,
        ip: string
    ): Promise<Creator> {
        // Use a repeatable hash function instead of a salted hash to allow for
        // finding the creator by either the Creator ID or the Creator Name, a
        // specific requirement due to how account creation and identification
        // is done in Hall of Fame.
        // This is not top-tier security, but it's good enough for Hall of Fame
        // where I decided to prioritize ease of use.
        const hasher = new Bun.CryptoHasher('blake2b256');

        const hashedCreatorId = hasher
            .update(creatorId.toLowerCase())
            .digest()
            .toString('base64');

        // Find the creator by either the Creator ID or the Creator Name.
        // If we find a match,
        // - If the Creator ID is incorrect, reject request.
        // - If the Creator ID is correct, we'll update the Creator Name if it
        //   changed.
        // If we don't find a match, create a new account.
        let creator = await this.prisma.creator.findFirst({
            where: {
                // biome-ignore lint/style/useNamingConvention: lib
                OR: [{ hashedCreatorId }, { creatorName }]
            }
        });

        if (creator) {
            // Check if the Creator ID and Creator Name are correct and update
            // info if needed.
            const { creator: updatedCreator, modified } =
                await this.authenticateAndUpdateCreator(
                    hashedCreatorId,
                    creatorName,
                    ip,
                    creator
                );

            creator = updatedCreator;

            if (modified) {
                this.logger.log(`Updated creator "${creator.creatorName}".`);
            }
        } else {
            // Create a new creator.
            creator = await this.prisma.creator.create({
                data: {
                    hashedCreatorId,
                    creatorName,
                    ipAddresses: [ip]
                }
            });

            this.logger.log(`Created creator "${creator.creatorName}".`);
        }

        return creator;
    }

    /**
     * Serializes a {@link Creator} to a JSON object for API responses.
     */
    public serialize(creator: Creator): JSONObject {
        return {
            id: creator.id,
            creatorName: creator.creatorName,
            createdAt: creator.createdAt.toISOString()
        };
    }

    /**
     * Verifies that the Creator ID and Creator Name are correct and updates
     */
    private async authenticateAndUpdateCreator(
        hashedCreatorId: string,
        creatorName: string,
        ip: string,
        creator: Creator
    ): Promise<{ creator: Creator; modified: boolean }> {
        // Check if the Creator ID hashes match.
        // Check if the database hash is non-null to allow for creator ID reset.
        if (
            creator.hashedCreatorId &&
            creator.hashedCreatorId != hashedCreatorId
        ) {
            let failedLoginAttempts = this.failedLoginAttempts.get(ip) ?? 0;

            this.failedLoginAttempts.set(ip, ++failedLoginAttempts);

            if (failedLoginAttempts >= this.maxFailedLoginAttempts) {
                await this.banService.banIp(
                    ip,
                    'too many failed login attempts'
                );

                this.failedLoginAttempts.delete(ip);

                // This will throw a more specific error than the one below
                // indicating "0 attempts left".
                await this.banService.ensureIpAddressNotBanned(ip);
            }

            const remainingAttempts =
                this.maxFailedLoginAttempts - failedLoginAttempts;

            throw new InvalidCreatorIdError(
                creator.creatorName,
                remainingAttempts
            );
        }

        // Reset failed login attempts if the login was successful.
        this.failedLoginAttempts.delete(ip);

        // If no changes are needed, return the creator as is.
        if (
            creator.creatorName == creatorName &&
            creator.ipAddresses.includes(ip) &&
            creator.hashedCreatorId == hashedCreatorId
        ) {
            return { creator, modified: false };
        }

        // Update the Creator Name and IP addresses, and hash if it was reset.
        const updatedCreator = await this.prisma.creator.update({
            where: creator.hashedCreatorId
                ? { hashedCreatorId }
                : { creatorName },
            data: {
                creatorName,
                hashedCreatorId,
                ipAddresses: Array.from(new Set([ip, ...creator.ipAddresses]))
            }
        });

        return { creator: updatedCreator, modified: true };
    }
}

export abstract class CreatorError extends StandardError {}

export class InvalidCreatorIdError extends CreatorError {
    public override kind = 'forbidden' as const;

    public constructor(
        public readonly creatorName: string,
        public readonly remainingAttempts: number
    ) {
        super(oneLine`
            Incorrect Creator ID for user "${creatorName}",
            ${remainingAttempts} attempt(s) remaining before ban.
            If you've never used HallOfFame before, this means this Creator Name
            is already claimed, choose another!`);
    }
}
