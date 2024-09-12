import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Creator } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import Bun from 'bun';
import { oneLine } from 'common-tags';
import * as uuid from 'uuid';
import {
    CreatorID,
    HardwareID,
    type JsonObject,
    StandardError
} from '../common';
import { PrismaService } from './prisma.service';

/**
 * Service to manage authenticate and manage Creators.
 */
@Injectable()
export class CreatorService {
    /**
     * Regular expression to validate a Creator Name:
     * - Must contain only letters, numbers, spaces, hyphens and apostrophes.
     * - Must be between 2 and 25 characters long.
     *
     * @see validateCreatorName
     * @see InvalidCreatorNameError
     */
    private static readonly nameRegex = /^[\p{L}\p{N}\- ']{2,25}$/u;

    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    private readonly logger = new Logger(CreatorService.name);

    /**
     * Validates that a string is a valid UUID v4 Creator ID.
     *
     * @throws InvalidCreatorIDError If it is not a valid UUID v4.
     */
    private static validateCreatorId(creatorId: string): CreatorID {
        if (uuid.validate(creatorId) && uuid.version(creatorId) == 4) {
            return creatorId as CreatorID;
        }

        throw new InvalidCreatorIDError(creatorId);
    }

    /**
     * Validates that a string is a valid Creator Name according to
     * {@link CreatorService.nameRegex}
     *
     * @throws InvalidCreatorNameError If it is not a valid Creator Name.
     */
    private static validateCreatorName(name: string): string {
        if (!name.match(CreatorService.nameRegex)) {
            throw new InvalidCreatorNameError(name);
        }

        return name;
    }

    /**
     * Creates a new Creator or retrieves an existing one.
     * This method is intended to be used as authentication and account creation
     * as it performs Creator Name/Creator ID validation and updates.
     *
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
    public async authenticateCreator(
        creatorId: string | CreatorID,
        creatorName: string,
        hwid: HardwareID
    ): Promise<Creator> {
        const hashedCreatorId = this.hashCreatorId(
            CreatorService.validateCreatorId(creatorId)
        );

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
                    hwid,
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
                    creatorName:
                        CreatorService.validateCreatorName(creatorName),
                    hwids: [hwid]
                }
            });

            this.logger.log(`Created creator "${creator.creatorName}".`);
        }

        return creator;
    }

    /**
     * Creates a new Creator with the provided Creator Name and Creator ID.
     * This method is intended to be used internally as there are no checks for
     * authentication.
     */
    public async createCreator(
        creatorName: string,
        creatorId: string | CreatorID = uuid.v4()
    ): Promise<{ creator: Creator; creatorId: CreatorID }> {
        const validCreatorId = CreatorService.validateCreatorId(creatorId);

        const hashedCreatorId = this.hashCreatorId(validCreatorId);

        const creator = await this.prisma.creator.create({
            data: {
                hashedCreatorId,
                creatorName
            }
        });

        this.logger.log(`Created creator "${creator.creatorName}".`);

        return { creator, creatorId: validCreatorId };
    }

    /**
     * Resets the Creator ID for a given Creator Name.
     * This method is intended to be used internally as there are no checks for
     * authentication.
     * If no Creator ID is provided, a new UUID v4 string will be generated.
     *
     * @throws IncorrectCreatorNameError If no match is found for
     *         {@link creatorName}
     */
    public async resetCreatorId(
        creatorName: string,
        creatorId: string | CreatorID = uuid.v4()
    ): Promise<{ creator: Creator; creatorId: CreatorID }> {
        const validCreatorId = CreatorService.validateCreatorId(creatorId);

        const hashedCreatorId = this.hashCreatorId(validCreatorId);

        try {
            const creator = await this.prisma.creator.update({
                where: { creatorName },
                data: {
                    hashedCreatorId
                }
            });

            this.logger.log(`Reset Creator ID for "${creator.creatorName}".`);

            return { creator, creatorId: validCreatorId };
        } catch (error) {
            if (
                error instanceof PrismaClientKnownRequestError &&
                error.code == 'P2025'
            ) {
                throw new IncorrectCreatorNameError(creatorId, {
                    cause: error
                });
            }

            throw error;
        }
    }

    /**
     * Serializes a {@link Creator} to a JSON object for API responses.
     */
    public serialize(creator: Creator): JsonObject {
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
        hwid: HardwareID,
        creator: Creator
    ): Promise<{ creator: Creator; modified: boolean }> {
        // Check if the Creator ID hashes match.
        // Check if the database hash is non-null to allow for creator ID reset.
        if (
            creator.hashedCreatorId &&
            creator.hashedCreatorId != hashedCreatorId
        ) {
            throw new IncorrectCreatorIDError(creator.creatorName);
        }

        // If no changes are needed, return the creator as is.
        if (
            creator.creatorName == creatorName &&
            creator.hwids.includes(hwid) &&
            creator.hashedCreatorId == hashedCreatorId
        ) {
            return { creator, modified: false };
        }

        // Update the Creator Name and Hardware IDs, and hash if it was reset.
        const updatedCreator = await this.prisma.creator.update({
            where: creator.hashedCreatorId
                ? { hashedCreatorId }
                : { creatorName },
            data: {
                creatorName:
                    creator.creatorName == creatorName
                        ? creatorName
                        : CreatorService.validateCreatorName(creatorName),
                hashedCreatorId,
                hwids: Array.from(new Set([hwid, ...creator.hwids]))
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

export class InvalidCreatorNameError extends CreatorError {
    public constructor(public readonly incorrectName: string) {
        super(oneLine`
            Creator Name "${incorrectName}" is invalid, it must contain only
            letters, numbers, spaces, hyphens and apostrophes, and be between 2
            and 25 characters long.`);
    }
}

export class IncorrectCreatorNameError extends CreatorError {
    public constructor(
        public readonly creatorName: string,
        options: ErrorOptions
    ) {
        super(`Creator "${creatorName}" does not exist.`, options);
    }
}

export class IncorrectCreatorIDError extends CreatorError {
    public override kind = 'forbidden' as const;

    public constructor(public readonly creatorName: string) {
        super(oneLine`
            Incorrect Creator ID for user "${creatorName}".
            If you've never used HallOfFame before, this means this Creator Name
            is already claimed, choose another!`);
    }
}
