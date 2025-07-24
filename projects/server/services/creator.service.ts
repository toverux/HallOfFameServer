import assert from 'node:assert/strict';
import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import * as sentry from '@sentry/bun';
import { oneLine } from 'common-tags';
import * as uuid from 'uuid';
import type { Creator } from '../../../prisma/generated/client';
import {
  type CreatorId,
  type HardwareId,
  type IpAddress,
  type JsonObject,
  StandardError
} from '../common';
import { isPrismaError } from '../common/prisma-errors';
import { config } from '../config';
import { AiTranslatorService } from './ai-translator.service';
import { PrismaService } from './prisma.service';

export type CreatorAuthorization = SimpleCreatorAuthorization | ModCreatorAuthorization;

/**
 * The simpler authorization scheme.
 * Allows logging in to an existing account with just a Creator ID, much like an API key.
 *
 * @see CreatorService.authenticateCreatorSimple
 */
export type SimpleCreatorAuthorization = Readonly<{
  kind: 'simple';
  creatorId: CreatorId;
  ip: IpAddress;
}>;

/**
 * More complex authorization scheme used by the mod.
 * It serves many purposes: checking that the Creator ID is correct, but also creating an account
 * from scratch (to allow register-less setup of Hall of Fame), or update account info like the
 * Creator name.
 *
 * @see CreatorService.authenticateCreatorForMod
 */
export type ModCreatorAuthorization = Readonly<{
  kind: 'mod';
  creatorName: Creator['creatorName'];
  creatorId: CreatorId;
  creatorIdProvider: Creator['creatorIdProvider'];
  hwid: HardwareId;
  ip: IpAddress;
}>;

/**
 * Service to manage and authenticate Creators.
 */
@Injectable()
export class CreatorService {
  /**
   * Regular expression to validate a Creator Name:
   * - Must contain only letters, numbers, spaces, hyphens, apostrophes, underscores and Chinese
   *   middle dot.
   * - Must be between 1 and 25 characters long. One-character-long names are for languages like
   *   Chinese.
   *
   * @see validateCreatorName
   * @see getCreatorNameSlug
   * @see InvalidCreatorNameError
   */
  private static readonly nameRegex = /^[\p{L}\p{N}\- '’_•]{1,25}$/u;

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(AiTranslatorService)
  private readonly aiTranslator!: AiTranslatorService;

  private readonly logger = new Logger(CreatorService.name);

  /**
   * Authenticates a creator based on the provided authorization kind and details.
   *
   * @see authenticateCreatorSimple
   * @see authenticateCreatorForMod
   */
  public async authenticateCreator(authorization: CreatorAuthorization): Promise<Creator> {
    // Validate the Creator ID.
    if (!uuid.validate(authorization.creatorId) || uuid.version(authorization.creatorId) != 4) {
      throw new InvalidCreatorIdError(authorization.creatorId);
    }

    switch (authorization.kind) {
      case 'simple':
        return await this.authenticateCreatorSimple(authorization);
      case 'mod':
        return await this.authenticateCreatorForMod(authorization);
      default:
        throw authorization satisfies never;
    }
  }

  /**
   * Contrarily to {@link authenticateCreatorForMod} which performs complex logic (creator ID/name
   * matching + account creation + account update), this method is more like a `checkApiKey()` and
   * only checks that the given Creator ID matches a creator, at which point you are considered
   * authenticated.
   */
  private async authenticateCreatorSimple({
    creatorId,
    ip
  }: SimpleCreatorAuthorization): Promise<Creator> {
    let creator = await this.prisma.creator.findUnique({ where: { creatorId } });

    if (!creator) {
      throw new CreatorNotFoundError();
    }

    // Update the last used IP address if it changed.
    if (creator.ips[0] != ip) {
      creator = await this.prisma.creator.update({
        where: { id: creator.id },
        data: {
          ips: Array.from(new Set([ip, ...creator.ips])).slice(0, 3)
        }
      });
    }

    return creator;
  }

  /**
   * Creates a new Creator or retrieves an existing one.
   * This method is to be used as authentication and account creation as it performs Creator Name/
   * Creator ID validation and updates.
   *
   * There are two possible outcomes:
   * - If the Creator ID doesn't match any record, a new Creator is created with the provided
   *   credentials.
   * - If the Creator ID matches a record, the request is authenticated, and the Creator Name is
   *   updated if it is changed.
   *
   * This is only a wrapper around {@link authenticateCreatorForModUnsafe} that handles concurrent
   * requests conflicts.
   */
  private async authenticateCreatorForMod(
    authorization: ModCreatorAuthorization
  ): Promise<Creator> {
    try {
      return await this.authenticateCreatorForModUnsafe(authorization);
    } catch (error) {
      // This can happen if a Creator account didn't exist and that user simultaneously sends
      // two authenticated requests that lead to the creation of the same Creator account due
      // to race condition, for example, "/me" and "/me/stats" when launching the mod.
      // In that case we only have to retry the authentication.
      if (isPrismaError(error) && error.code == 'P2002') {
        return await this.authenticateCreatorForModUnsafe(authorization);
      }

      throw error;
    }
  }

  /**
   * See {@link authenticateCreatorForMod} for the method's purpose, this is only the part of the
   * authentication that can be retried in case of error due to concurrent requests leading to an
   * account creation (and therefore a unique constraint violation).
   */
  public async authenticateCreatorForModUnsafe({
    creatorId,
    creatorIdProvider,
    creatorName,
    hwid,
    ip
  }: ModCreatorAuthorization): Promise<Creator> {
    // Note: we do NOT validate the Creator Name immediately, as we need to support legacy
    // Creator Names that were validated with a different regex.
    // We validate it only when an account is created or updated.

    // Find the creator by either the Creator ID or the Creator Name.
    // If we find a match,
    // - If the Creator ID is incorrect (not a UUID), reject request.
    // - If the Creator ID is correct, we'll update the Creator Name if it changed.
    // If we don't find a match, create a new account.
    const creatorNameSlug = this.getCreatorNameSlug(creatorName);

    const creators = await this.prisma.creator.findMany({
      where: creatorName
        ? {
            // biome-ignore lint/style/useNamingConvention: lib
            OR: [{ creatorId }, { creatorName }, { creatorNameSlug }]
          }
        : { creatorId }
    });

    // This can happen if we matched an existing Creator ID (so far so good) but that the
    // Creator Name is being changed to a name that is already taken.
    // This returns two creators, one matching the Creator ID and one matching the Creator Name.
    if (creators.length > 1) {
      assert(
        creators.length == 2,
        `Only two creators are returned, otherwise there are non-unique Creator Names.`
      );

      assert(creatorName, `Creator Name can only be non-null if >1 creators are found.`);

      throw new IncorrectCreatorIdError(creatorName);
    }

    // After this previous check we know that the first and only creator is the one we want to
    // authenticate or create.
    const creator = creators[0];

    return creator ? updateCreator.call(this) : createCreator.call(this);

    async function createCreator(this: CreatorService): Promise<Creator> {
      // Create a new creator.
      const newCreator = await this.prisma.creator.create({
        data: {
          creatorId,
          creatorIdProvider,
          creatorName: CreatorService.validateCreatorName(creatorName),
          creatorNameSlug,
          hwids: [hwid],
          ips: [ip],
          socials: []
        }
      });

      backgroundUpdateCreatorNameTranslation.call(this, newCreator);

      this.logger.log(`Created creator "${newCreator.creatorName}".`);

      return newCreator;
    }

    async function updateCreator(this: CreatorService): Promise<Creator> {
      assert(creator);

      // Check if the Creator ID match, unless the reset flag is set.
      if (creator.creatorId != creatorId && !creator.allowCreatorIdReset) {
        // This should never happen, as when we enter this condition, it means that we matched
        // on the Creator Name and not the Creator ID.
        assert(creator.creatorName);

        throw new IncorrectCreatorIdError(creator.creatorName);
      }

      const modified =
        creator.creatorName != creatorName ||
        creator.creatorNameSlug != creatorNameSlug ||
        creator.hwids[0] != hwid ||
        creator.ips[0] != ip ||
        creator.creatorId != creatorId;

      if (!modified) {
        return creator;
      }

      // Update the Creator Name and Hardware IDs, and Creator ID if it was reset.
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
          hwids: Array.from(new Set([hwid, ...creator.hwids])).slice(0, 3),
          ips: Array.from(new Set([ip, ...creator.ips])).slice(0, 3)
        }
      });

      if (updatedCreator.creatorName != creator.creatorName) {
        backgroundUpdateCreatorNameTranslation.call(this, updatedCreator);
      }

      this.logger.log(`Updated creator "${creator.creatorName}".`);

      return updatedCreator;
    }

    function backgroundUpdateCreatorNameTranslation(
      this: CreatorService,
      creatorToTranslate: Creator
    ): void {
      this.updateCreatorNameTranslation(creatorToTranslate).catch(error => {
        this.logger.error(
          `Failed to translate creator name "${creatorToTranslate.creatorName}" (#${creatorToTranslate.id}).`,
          error
        );

        sentry.captureException(error);
      });
    }
  }

  /**
   * Transforms a Creator Name to a slug-style one used to check for username collisions or future
   * URL routing.
   */
  public getCreatorNameSlug(name: string | null): string | null {
    if (!name?.trim()) {
      return null;
    }

    return (
      name
        .replaceAll("'", '')
        .replaceAll('’', '')
        // Replace consecutive spaces or hyphens with a single hyphen.
        .replace(/\s+|-+/g, '-')
        // Remove leading and trailing hyphens.
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
    );
  }

  /**
   * Update of the transliteration and translation of the creator name for the given screenshot,
   * ignoring {@link Creator.needsTranslation}.
   * Skips creators with names that are not eligible to transliteration/translation (see
   * {@link AiTranslatorService.isEligibleForTranslation}).
   */
  public async updateCreatorNameTranslation(
    creator: Pick<Creator, 'id' | 'creatorName'>
  ): Promise<{ translated: false } | { translated: true; creator: Creator }> {
    // If no translation is needed, mark the creator as not needing translation.
    if (
      !(creator.creatorName && AiTranslatorService.isEligibleForTranslation(creator.creatorName))
    ) {
      await this.prisma.creator.update({
        where: { id: creator.id },
        data: {
          needsTranslation: false,
          creatorNameLocale: null,
          creatorNameLatinized: null,
          creatorNameTranslated: null
        }
      });

      return { translated: false };
    }

    const result = await this.aiTranslator.translateCreatorName({
      creatorId: creator.id,
      input: creator.creatorName
    });

    // Update the screenshot with the new values.
    const updatedCreator = await this.prisma.creator.update({
      where: { id: creator.id },
      data: {
        needsTranslation: false,
        creatorNameLocale: result.twoLetterLocaleCode,
        creatorNameLatinized: result.transliteration,
        creatorNameTranslated: result.translation
      }
    });

    return { translated: true, creator: updatedCreator };
  }

  /**
   * Serializes a {@link Creator} to a JSON object for API responses.
   */
  public serialize(creator: Creator): JsonObject {
    return {
      id: creator.id,
      creatorName: creator.creatorName,
      creatorNameSlug: creator.creatorNameSlug,
      creatorNameLocale: creator.creatorNameLocale,
      creatorNameLatinized: creator.creatorNameLatinized,
      creatorNameTranslated: creator.creatorNameTranslated,
      createdAt: creator.createdAt.toISOString(),
      citiesCollectiveId: creator.citiesCollectiveId,
      socials: creator.socials.map(social => ({
        platform: social.platform,
        link: `${config.http.baseUrl}/api/v1/creators/${creator.id}/social/${social.platform}`,
        clicks: social.clicks
      }))
    };
  }

  /**
   * Validates that a string is a valid Creator Name according to {@link CreatorService.nameRegex}
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
}

export abstract class CreatorError extends StandardError {}

export class InvalidCreatorIdError extends CreatorError {
  public readonly creatorId: string;

  public constructor(creatorId: string) {
    super(`Invalid Creator ID "${creatorId}", an UUID v4 sequence was expected.`);

    this.creatorId = creatorId;
  }
}

export class InvalidCreatorNameError extends CreatorError {
  public readonly incorrectName: string;

  public constructor(incorrectName: string) {
    super(
      oneLine`
      Creator Name "${incorrectName}" is invalid, it must contain only
      letters, numbers, spaces, hyphens and apostrophes, and be between 1
      and 25 characters long.`
    );

    this.incorrectName = incorrectName;
  }
}

export class CreatorNotFoundError extends CreatorError {
  public constructor() {
    super(`No Creator with this Creator ID was found.`);
  }
}

export class IncorrectCreatorIdError extends CreatorError {
  public override httpErrorType = ForbiddenException;

  public readonly creatorName: string;

  public constructor(creatorName: string) {
    super(
      oneLine`
      Incorrect Creator ID for user "${creatorName}".
      If you've never used HallOfFame before or just changed your Creator
      Name, this means this username is already claimed, choose another!
      Otherwise, check that you are logged in with the correct Paradox
      account.`
    );

    this.creatorName = creatorName;
  }
}
