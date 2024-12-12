import assert from 'node:assert/strict';
import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Creator } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { oneLine } from 'common-tags';
import * as uuid from 'uuid';
import { HardwareID, IPAddress, JsonObject, StandardError } from '../common';
import { CreatorAuthorization } from '../guards';
import { PrismaService } from './prisma.service';

/**
 * Service to manage authenticate and manage Creators.
 */
@Injectable()
export class CreatorService {
    /**
     * Regular expression to validate a Creator Name:
     * - Must contain only letters, numbers, spaces, hyphens, apostrophes and
     *   underscores.
     * - Must be between 1 and 25 characters long. 1-character-long names are
     *   for languages like Chinese.
     *
     * @see validateCreatorName
     * @see getCreatorNameSlug
     * @see InvalidCreatorNameError
     */
    private static readonly nameRegex = /^[\p{L}\p{N}\- '’_]{1,25}$/u;

    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    private readonly logger = new Logger(CreatorService.name);

    /**
     * Validates that a string is a valid Creator Name according to
     * {@link CreatorService.nameRegex}
     *
     * @throws InvalidCreatorNameError If it is not a valid Creator Name.
     */
    private static validateCreatorName(name: string | null): string | null {
        if (!name?.trim()) {
            return null;
        }

        if (!name.match(CreatorService.nameRegex)) {
            throw new InvalidCreatorNameError(name);
        }

        // Normalize multiple spaces to a single space.
        return name.replace(/\s+/g, ' ');
    }

    /**
     * Transforms a Creator Name to a slug-style one used to check for username
     * collisions or future URL routing.
     */
    private static getCreatorNameSlug(name: string | null): string | null {
        if (!name?.trim()) {
            return null;
        }

        return (
            name
                .replaceAll("'", '')
                .replaceAll('’', '')
                // Replace consecutive spaces or hyphens by a single hyphen.
                .replace(/\s+|-+/g, '-')
                // Remove leading and trailing hyphens.
                .replace(/^-+|-+$/g, '')
                .toLowerCase()
        );
    }

    /**
     * Creates a new Creator or retrieves an existing one.
     * This method is intended to be used as authentication and account creation
     * as it performs Creator Name/Creator ID validation and updates.
     *
     * There are two possible outcomes:
     * - If the Creator ID doesn't match any record, a new Creator is created
     *   with the provided credentials.
     * - If the Creator ID matches a record, the request is authenticated, and
     *   the Creator Name is updated if it changed.
     *
     * Just a wrapper around {@link authenticateCreatorUnsafe} that handles
     * concurrent requests conflicts.
     */
    public async authenticateCreator(
        authorization: CreatorAuthorization
    ): Promise<Creator> {
        try {
            return await this.authenticateCreatorUnsafe(authorization);
        } catch (error) {
            // This can happen if a Creator account didn't exist and that user
            // simultaneously sends two authenticated requests that lead to the
            // creation of the same Creator account due to race condition, for
            // example /me and /me/stats when launching the mod.
            // In that case we just have to retry the authentication.
            if (
                error instanceof PrismaClientKnownRequestError &&
                error.code == 'P2002'
            ) {
                return await this.authenticateCreatorUnsafe(authorization);
            }

            throw error;
        }
    }

    /**
     * See {@link authenticateCreator} for the method's purpose, this is just
     * the part of the authentication that can be retried in case of error due
     * to concurrent requests leading to an account creation (and therefore a
     * unique constraint violation).
     */
    public async authenticateCreatorUnsafe({
        creatorId,
        creatorIdProvider,
        creatorName,
        hwid,
        ip
    }: CreatorAuthorization): Promise<Creator> {
        // Validate the Creator ID.
        if (!uuid.validate(creatorId) || uuid.version(creatorId) != 4) {
            throw new InvalidCreatorIDError(creatorId);
        }

        // Note: we do NOT validate the Creator Name immediately, as we need to
        // support legacy Creator Names that were validated with a different
        // regex. We validate it only when an account is created or updated.

        // Find the creator by either the Creator ID or the Creator Name.
        // If we find a match,
        // - If the Creator ID is incorrect (not a UUID), reject request.
        // - If the Creator ID is correct, we'll update the Creator Name if it
        //   changed.
        // If we don't find a match, create a new account.
        const creatorNameSlug = CreatorService.getCreatorNameSlug(creatorName);

        const creators = await this.prisma.creator.findMany({
            where: creatorName
                ? {
                      // biome-ignore lint/style/useNamingConvention: lib
                      OR: [{ creatorId }, { creatorName }, { creatorNameSlug }]
                  }
                : { creatorId }
        });

        // This can happen if we matched an existing Creator ID (so far so good)
        // but that the Creator Name is being changed to a name that is already
        // taken.
        // This returns two creators, one matching the Creator ID and one
        // matching the Creator Name.
        if (creators.length > 1) {
            assert(
                creators.length == 2,
                `Only two creators are returned, otherwise there are non-unique Creator Names.`
            );

            assert(
                creatorName,
                `Creator Name can only be non-null if >1 creators are found.`
            );

            throw new IncorrectCreatorIDError(creatorName);
        }

        // After this previous check we know that the first and only creator is
        // the one we want to authenticate or create.
        let creator = creators[0];

        if (creator) {
            // Check if the Creator ID and Creator Name are correct and update
            // info if needed.
            const { creator: updatedCreator, modified } =
                await this.authenticateAndUpdateCreator(
                    creatorId,
                    creatorIdProvider,
                    creatorName,
                    creatorNameSlug,
                    hwid,
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
                    creatorId,
                    creatorIdProvider,
                    creatorName:
                        CreatorService.validateCreatorName(creatorName),
                    creatorNameSlug,
                    hwids: [hwid],
                    ips: [ip]
                }
            });

            this.logger.log(`Created creator "${creator.creatorName}".`);
        }

        return creator;
    }

    /**
     * Serializes a {@link Creator} to a JSON object for API responses.
     */
    public serialize(creator: Creator): JsonObject {
        return {
            id: creator.id,
            creatorName: creator.creatorName,
            creatorNameSlug: creator.creatorNameSlug,
            createdAt: creator.createdAt.toISOString()
        };
    }

    /**
     * Verifies that the Creator ID and Creator Name are correct and updates
     */
    private async authenticateAndUpdateCreator(
        creatorId: Creator['creatorId'],
        creatorIdProvider: Creator['creatorIdProvider'],
        creatorName: Creator['creatorName'],
        creatorNameSlug: Creator['creatorNameSlug'],
        hwid: HardwareID,
        ip: IPAddress,
        creator: Creator
    ): Promise<{ creator: Creator; modified: boolean }> {
        // Check if the Creator ID match, unless the reset flag is set.
        if (creator.creatorId != creatorId && !creator.allowCreatorIdReset) {
            // This should never happen, as when we enter this condition, it
            // means that we matched on the Creator Name and not the Creator ID.
            assert(creator.creatorName);

            throw new IncorrectCreatorIDError(creator.creatorName);
        }

        // If no changes are needed, return the creator as is.
        if (
            creator.creatorName == creatorName &&
            creator.creatorNameSlug == creatorNameSlug &&
            creator.hwids.includes(hwid) &&
            creator.ips.includes(ip) &&
            creator.creatorId == creatorId
        ) {
            return { creator, modified: false };
        }

        // Update the Creator Name and Hardware IDs, and Creator ID if it was
        // reset.
        const updatedCreator = await this.prisma.creator.update({
            where: { id: creator.id },
            data: {
                creatorName:
                    // Validate the Creator Name if it changed.
                    creator.creatorName == creatorName
                        ? creatorName
                        : CreatorService.validateCreatorName(creatorName),
                creatorNameSlug,
                allowCreatorIdReset: false,
                creatorId,
                creatorIdProvider,
                hwids: Array.from(new Set([hwid, ...creator.hwids])),
                ips: Array.from(new Set([ip, ...creator.ips]))
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
            letters, numbers, spaces, hyphens and apostrophes, and be between 1
            and 25 characters long.`);
    }
}

export class IncorrectCreatorIDError extends CreatorError {
    public override httpErrorType = ForbiddenException;

    public constructor(public readonly creatorName: string) {
        super(oneLine`
            Incorrect Creator ID for user "${creatorName}".
            If you've never used HallOfFame before or just changed your Creator
            Name, this means this username is already claimed, choose another!
            Otherwise, check that you are logged in with the correct Paradox
            account.`);
    }
}
