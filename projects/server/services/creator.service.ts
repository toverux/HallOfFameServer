import assert from 'node:assert/strict';
import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Creator, CreatorSocial } from '@prisma/client';
import * as sentry from '@sentry/bun';
import { oneLine } from 'common-tags';
import * as uuid from 'uuid';
import { type HardwareId, type IpAddress, type JsonObject, StandardError } from '../common';
import { isPrismaError } from '../common/prisma-errors';
import type { CreatorAuthorization } from '../guards';
import { AiTranslatorService } from './ai-translator.service';
import { PrismaService } from './prisma.service';

type SocialLinkMapper = {
  [TPlatform in keyof CreatorSocial]: (link: NonNullable<CreatorSocial[TPlatform]>) => string;
};

/**
 * Service to manage authenticate and manage Creators.
 */
@Injectable()
export class CreatorService {
  /**
   * An object with functions to map a supported social media to an HTTP link.
   */
  public static readonly formatSocialLink = {
    discordServer: link => `https://discord.gg/${link.code}`,
    paradoxMods: link => `https://mods.paradoxplaza.com/authors/${link.username}/cities_skylines_2`,
    reddit: link => `https://reddit.com/user/${link.username}`,
    twitch: link => `https://twitch.tv/${link.channel}`,
    youtube: link => `https://youtube.com/@${link.channel}`
  } satisfies SocialLinkMapper;

  /**
   * An object with functions to map a supported social media to a description.
   */
  public static readonly formatSocialLinkDescription = {
    discordServer: link => `Join ${link.serverName} on Discord`,
    paradoxMods: link => `${link.username} on Paradox Mods`,
    reddit: link => `u/${link.username} on Reddit`,
    twitch: link => `${link.channel} on Twitch`,
    youtube: link => `@${link.channel} on YouTube`
  } satisfies SocialLinkMapper;

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

  public static isValidSocialPlatform(platform: string): platform is keyof CreatorSocial {
    return platform in CreatorService.formatSocialLink;
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
   *   updated if it changed.
   *
   * This is only a wrapper around {@link authenticateCreatorUnsafe} that handles concurrent
   * requests conflicts.
   */
  public async authenticateCreator(authorization: CreatorAuthorization): Promise<Creator> {
    try {
      return await this.authenticateCreatorUnsafe(authorization);
    } catch (error) {
      // This can happen if a Creator account didn't exist and that user simultaneously sends
      // two authenticated requests that lead to the creation of the same Creator account due
      // to race condition, for example, "/me" and "/me/stats" when launching the mod.
      // In that case we only have to retry the authentication.
      if (isPrismaError(error) && error.code == 'P2002') {
        return await this.authenticateCreatorUnsafe(authorization);
      }

      throw error;
    }
  }

  /**
   * See {@link authenticateCreator} for the method's purpose, this is only the part of the
   * authentication that can be retried in case of error due to concurrent requests leading to an
   * account creation (and therefore a unique constraint violation).
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
      throw new InvalidCreatorIdError(creatorId);
    }

    // Note: we do NOT validate the Creator Name immediately, as we need to support legacy
    // Creator Names that were validated with a different regex.
    // We validate it only when an account is created or updated.

    // Find the creator by either the Creator ID or the Creator Name.
    // If we find a match,
    // - If the Creator ID is incorrect (not a UUID), reject request.
    // - If the Creator ID is correct, we'll update the Creator Name if it changed.
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
    let creator = creators[0];

    if (creator) {
      // Check if the Creator ID and Creator Name are correct and update information if needed.
      const { creator: updatedCreator, modified } = await this.authenticateAndUpdateCreator(
        creatorId,
        creatorIdProvider,
        creatorName,
        creatorNameSlug,
        hwid,
        ip,
        creator
      );

      if (updatedCreator.creatorName != creator.creatorName) {
        backgroundUpdateCreatorNameTranslation.call(this);
      }

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
          creatorName: CreatorService.validateCreatorName(creatorName),
          creatorNameSlug,
          hwids: [hwid],
          ips: [ip],
          social: {}
        }
      });

      backgroundUpdateCreatorNameTranslation.call(this);

      this.logger.log(`Created creator "${creator.creatorName}".`);
    }

    return creator;

    function backgroundUpdateCreatorNameTranslation(this: CreatorService): void {
      assert(creator);

      this.updateCreatorNameTranslation(creator).catch(error => {
        this.logger.error(
          `Failed to translate creator name "${creator.creatorName}" (#${creator.id}).`,
          error
        );

        sentry.captureException(error);
      });
    }
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
    // If no translation is needed, mark the screenshot as not needing translation.
    if (
      !(creator.creatorName && AiTranslatorService.isEligibleForTranslation(creator.creatorName))
    ) {
      await this.prisma.creator.update({
        where: { id: creator.id },
        data: { needsTranslation: false }
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
      social: Object.entries(creator.social)
        .filter(
          (kv): kv is [keyof CreatorSocial, NonNullable<CreatorSocial[keyof CreatorSocial]>] =>
            CreatorService.isValidSocialPlatform(kv[0]) && kv[1] != null
        )
        .reduce<Record<string, JsonObject>>((social, [platform, link]) => {
          social[platform] = {
            description: CreatorService.formatSocialLinkDescription[platform]({
              // Little contraption to avoid a type error and stay strict.
              channel: '',
              code: '',
              serverName: '',
              username: '',
              ...link
            }),
            link: `/api/v1/creators/${creator.id}/social/${platform}`,
            ...link
          };

          return social;
        }, {})
    };
  }

  /**
   * Authenticates and updates a creator's information (like its Creator Name), ensuring the
   * provided details match or are updated in the database.
   *
   * @throws IncorrectCreatorIdError If the provided Creator ID doesn't match the Creator Name.
   *
   * @return A promise that resolves with the updated creator entity, and a boolean indicating if modifications were made.
   */
  private async authenticateAndUpdateCreator(
    creatorId: Creator['creatorId'],
    creatorIdProvider: Creator['creatorIdProvider'],
    creatorName: Creator['creatorName'],
    creatorNameSlug: Creator['creatorNameSlug'],
    hwid: HardwareId,
    ip: IpAddress,
    creator: Creator
  ): Promise<{ creator: Creator; modified: boolean }> {
    // Check if the Creator ID match, unless the reset flag is set.
    if (creator.creatorId != creatorId && !creator.allowCreatorIdReset) {
      // This should never happen, as when we enter this condition, it means that we matched
      // on the Creator Name and not the Creator ID.
      assert(creator.creatorName);

      throw new IncorrectCreatorIdError(creator.creatorName);
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
        hwids: Array.from(new Set([hwid, ...creator.hwids])),
        ips: Array.from(new Set([ip, ...creator.ips]))
      }
    });

    return { creator: updatedCreator, modified: true };
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

  /**
   * Transforms a Creator Name to a slug-style one used to check for username collisions or future
   * URL routing.
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
