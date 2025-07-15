import { Inject, Injectable } from '@nestjs/common';
import type { Creator, Favorite, Screenshot } from '@prisma/client';
import { type JsonObject, optionallySerialized, StandardError } from '../common';
import { CreatorService } from './creator.service';
import { PrismaService } from './prisma.service';

@Injectable()
export class FavoriteService {
  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(CreatorService)
  private readonly creatorService!: CreatorService;

  /**
   * Checks if a screenshot is favorited by a unique user.
   *
   * @see isFavoriteBatched
   */
  public async isFavorite(
    screenshotId: Screenshot['id'],
    creator: Pick<Creator, 'id' | 'hwids' | 'ips'>
  ): Promise<boolean> {
    // Find a favorite with any of the provided identifiers; multi-accounting is not allowed for
    // favorites, so a favorite is shared by any of these, hence the OR clause.
    const favorite = await this.prisma.favorite.findFirst({
      select: { id: true },
      where: {
        // biome-ignore lint/style/useNamingConvention: prisma
        OR: [
          { screenshotId, creatorId: creator.id },
          { screenshotId, hwid: { in: creator.hwids } },
          { screenshotId, ip: { in: creator.ips } }
        ]
      }
    });

    return favorite != null;
  }

  /**
   * Determines for each screenshot in a batch if it has been favorited by a unique user.
   *
   * @return A promise that resolves to an array of booleans, where each element corresponds to
   *         whether the given screenshot ID is marked as a favorite, ordered 1:1 to the input.
   *
   * @see isFavorite
   */
  public async isFavoriteBatched(
    screenshotIds: readonly Screenshot['id'][],
    creator: Pick<Creator, 'id' | 'hwids' | 'ips'>
  ): Promise<boolean[]> {
    // Same as isFavorite(), see its comments.
    const favorites = await this.prisma.favorite.findMany({
      select: { id: true, screenshotId: true },
      where: {
        // biome-ignore lint/style/useNamingConvention: prisma
        OR: [
          // `as string[]`: because prisma type unnecessarily takes a mutable array.
          { screenshotId: { in: screenshotIds as string[] }, creatorId: creator.id },
          { screenshotId: { in: screenshotIds as string[] }, hwid: { in: creator.hwids } },
          { screenshotId: { in: screenshotIds as string[] }, ip: { in: creator.hwids } }
        ]
      }
    });

    return screenshotIds.map(screenshotId =>
      favorites.some(favorite => favorite.screenshotId == screenshotId)
    );
  }

  /**
   * Adds a favorite to a screenshot.
   */
  public async addFavorite(
    screenshotId: Screenshot['id'],
    creator: Pick<Creator, 'id' | 'hwids' | 'ips'>
  ): Promise<Favorite> {
    // Check if the user has already favorited this screenshot.
    // We can't use .findUnique() because of the OR clause.
    // The compound indexes [creatorId, screenshotId], etc. are still used!
    const favorite = await this.prisma.favorite.findFirst({
      select: { id: true },
      where: {
        // biome-ignore lint/style/useNamingConvention: prisma
        OR: [
          { screenshotId, creatorId: creator.id },
          { screenshotId, hwid: { in: creator.hwids } },
          { screenshotId, ip: { in: creator.ips } }
        ]
      }
    });

    // If the user has already favorited this screenshot, throw an error.
    if (favorite) {
      throw new AlreadyInFavoritesError();
    }

    // Increment the favorite count of the screenshot.
    await this.prisma.screenshot.update({
      where: { id: screenshotId },
      data: {
        favoritesCount: { increment: 1 }
      }
    });

    // Create a new favorite.
    return this.prisma.favorite.create({
      data: {
        screenshotId,
        creatorId: creator.id,
        // biome-ignore lint/style/noNonNullAssertion: IP address should never be null in practice
        ip: creator.ips[0]!,
        hwid: creator.hwids[0] ?? null
      }
    });
  }

  /**
   * Removes a favorite from a screenshot.
   */
  public async removeFavorite(
    screenshotId: Screenshot['id'],
    creator: Pick<Creator, 'id' | 'hwids' | 'ips'>
  ): Promise<Favorite> {
    // Find the favorite to remove.
    // We can't use .remove() directly because we can't use .remove() which requires a where
    // clause that guarantees uniqueness, but we use an OR clause.
    const favorite = await this.prisma.favorite.findFirst({
      where: {
        // biome-ignore lint/style/useNamingConvention: prisma
        OR: [
          { screenshotId, creatorId: creator.id },
          { screenshotId, hwid: { in: creator.hwids } },
          { screenshotId, ip: { in: creator.ips } }
        ]
      }
    });

    // If the user has not favorited this screenshot, throw an error.
    if (!favorite) {
      throw new NotInFavoritesError();
    }

    // Decrement the favorite count of the screenshot.
    await this.prisma.screenshot.update({
      where: { id: screenshotId },
      data: {
        favoritesCount: { decrement: 1 }
      }
    });

    // Remove the favorite.
    return this.prisma.favorite.delete({
      where: { id: favorite.id }
    });
  }

  /**
   * Serializes a {@link Favorite} to a JSON object for API responses.
   */
  public serialize(favorite: Favorite & { creator?: Creator }): JsonObject {
    return {
      id: favorite.id,
      favoritedAt: favorite.favoritedAt.toISOString(),
      creatorId: favorite.creatorId,
      creator: optionallySerialized(
        favorite.creator && this.creatorService.serialize(favorite.creator)
      ),
      screenshotId: favorite.screenshotId
    };
  }
}

export abstract class FavoriteError extends StandardError {}

export class NotInFavoritesError extends FavoriteError {
  public constructor(options?: ErrorOptions) {
    super(`You have not favorited this screenshot.`, options);
  }
}

export class AlreadyInFavoritesError extends FavoriteError {
  public constructor(options?: ErrorOptions) {
    super(`You have already favorited this screenshot.`, options);
  }
}
