import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Creator } from '@prisma/client';
import Bun from 'bun';
import { oneLine } from 'common-tags';
import { LRUCache } from 'lru-cache';
import * as uuid from 'uuid';
import {
    CreatorID,
    type IPAddress,
    type JSONObject,
    StandardError
} from '../common';
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

    /**
     * Maximum number of failed login attempts before an IP is permanently
     * banned.
     */
    private readonly maxFailedLoginAttempts = 4;

    /**
     * Tracks failed login attempts by IP address.
     */
    private readonly failedLoginAttempts = new LRUCache<IPAddress, number>({
        max: 200
    });

    /**
     * Validates that a string is a valid UUID v4 Creator ID.
     *
     * @throws InvalidCreatorIDError If the string is not a valid UUID v4.
     */
    public static validateCreatorId(creatorId: string): CreatorID {
        if (uuid.validate(creatorId) && uuid.version(creatorId) == 4) {
            return creatorId as CreatorID;
        }

        throw new InvalidCreatorIDError(creatorId);
    }

    /**
     * Retrieves a Creator by their Creator ID.
     *
     * @returns The Creator if found, otherwise null.
     */
    public getCreator(creatorId: CreatorID): Promise<Creator | null> {
        const hashedCreatorId = this.hashCreatorId(creatorId);

        return this.prisma.creator.findFirst({
            where: { hashedCreatorId }
        });
    }

    /**
     * Creates a new Creator or retrieves an existing one.
     * There are three possible outcomes:
     * - If the Creator ID and Creator Name don't match any record, a new
     *   Creator is created with the provided credentials.
     * - If the Creator ID matches a record, the request is authenticated, and
     *   the Creator Name is updated if it changed.
     * - If the Creator ID doesn't match a record, but the Creator Name does,
     *   then the person has the wrong Creator ID and an authentication error is
     *   thrown.
     *
     * @throws IncorrectCreatorIDError If the Creator ID is incorrect for the
     *         provided Creator Name.
     */
    public async getOrCreateCreator(
        creatorId: CreatorID,
        creatorName: string,
        ipAddress: IPAddress
    ): Promise<Creator> {
        const hashedCreatorId = this.hashCreatorId(creatorId);

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
                    ipAddress,
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
                    ipAddresses: [ipAddress]
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
     * Hashes the Creator ID for storage in the database.
     */
    private hashCreatorId(creatorId: CreatorID): string {
        // Use a repeatable hash function instead of a salted hash to allow for
        // finding the creator by either the Creator ID or the Creator Name, a
        // specific requirement due to how account creation and identification
        // is done in Hall of Fame.
        // This is not top-tier security, but it's good enough for Hall of Fame
        // where I decided to prioritize ease of use.
        const hasher = new Bun.CryptoHasher('blake2b256');

        return hasher
            .update(creatorId.toLowerCase())
            .digest()
            .toString('base64');
    }

    /**
     * Verifies that the Creator ID and Creator Name are correct and updates
     */
    private async authenticateAndUpdateCreator(
        hashedCreatorId: string,
        creatorName: string,
        ipAddress: IPAddress,
        creator: Creator
    ): Promise<{ creator: Creator; modified: boolean }> {
        // Check if the Creator ID hashes match.
        // Check if the database hash is non-null to allow for creator ID reset.
        if (
            creator.hashedCreatorId &&
            creator.hashedCreatorId != hashedCreatorId
        ) {
            let failedLoginAttempts =
                this.failedLoginAttempts.get(ipAddress) ?? 0;

            this.failedLoginAttempts.set(ipAddress, ++failedLoginAttempts);

            if (failedLoginAttempts >= this.maxFailedLoginAttempts) {
                await this.banService.banIp(
                    ipAddress,
                    'too many failed login attempts'
                );

                this.failedLoginAttempts.delete(ipAddress);

                // This will throw a more specific error than the one below
                // indicating "0 attempts left".
                await this.banService.ensureIpAddressNotBanned(ipAddress);
            }

            const remainingAttempts =
                this.maxFailedLoginAttempts - failedLoginAttempts;

            throw new IncorrectCreatorIDError(
                creator.creatorName,
                remainingAttempts
            );
        }

        // Reset failed login attempts if the login was successful.
        this.failedLoginAttempts.delete(ipAddress);

        // If no changes are needed, return the creator as is.
        if (
            creator.creatorName == creatorName &&
            creator.ipAddresses.includes(ipAddress) &&
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
                ipAddresses: Array.from(
                    new Set([ipAddress, ...creator.ipAddresses])
                )
            }
        });

        return { creator: updatedCreator, modified: true };
    }
}

export abstract class CreatorError extends StandardError {}

export class InvalidCreatorIDError extends CreatorError {
    public constructor(public readonly creatorId: string) {
        super(
            `Invalid Creator ID "${creatorId}", an UUID v4 sequence was expected.`
        );
    }
}

export class IncorrectCreatorIDError extends CreatorError {
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
