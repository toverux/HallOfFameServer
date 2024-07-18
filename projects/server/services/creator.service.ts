import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Creator } from '@prisma/client';
import Bun from 'bun';
import { JSONObject } from '../common';
import { PrismaService } from './prisma.service';

/**
 * Service to manage authenticate and manage Creators.
 */
@Injectable()
export class CreatorService {
    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    private readonly logger = new Logger(CreatorService.name);

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
            throw new InvalidCreatorIdError(creator.creatorName);
        }

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

export abstract class CreatorServiceError extends Error {}

export class InvalidCreatorIdError extends CreatorServiceError {
    public constructor(creatorName: string) {
        super(`Incorrect Creator ID for user "${creatorName}".`);
    }
}
