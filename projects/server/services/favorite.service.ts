import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Creator, Favorite, Prisma, Screenshot } from '#prisma-lib/client';
import { type JsonObject, optionallySerialized } from '../../shared/utils/json';
import { nn } from '../../shared/utils/type-assertion';
import { StandardError } from '../common/standard-error';
import { CreatorService } from './creator.service';
import { PrismaService } from './prisma.service';
import { ScreenshotStatsService } from './screenshot-stats.service';

@Injectable()
export class FavoriteService {
  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(CreatorService)
  private readonly creatorService!: CreatorService;

  @Inject(ScreenshotStatsService)
  private readonly screenshotStatsService!: ScreenshotStatsService;

  /**
   * Checks if a screenshot is favorited by a unique user.
   *
   * @see isFavoriteBatched
   */
  public async isFavorite(
    screenshotId: Screenshot['id'],
    creator: Pick<Creator, 'id' | 'hwids' | 'ips'>
  ): Promise<boolean> {
    const favorite = await this.prisma.favorite.findFirst({
      select: { id: true },
      where: uniqueUserFavorites(screenshotId, creator)
    });

    return favorite != null;
  }

  /**
   * Determines for each screenshot in a batch if it has been favorited by a unique user.
   *
   * @returns A promise that resolves to an array of booleans, where each element corresponds to
   *   whether the given screenshot ID is marked as a favorite, ordered 1:1 to the input.
   *
   * @see isFavorite
   */
  public async isFavoriteBatched(
    screenshotIds: ReadonlyArray<Screenshot['id']>,
    creator: Pick<Creator, 'id' | 'hwids' | 'ips'>
  ): Promise<boolean[]> {
    const favorites = await this.prisma.favorite.findMany({
      select: { id: true, screenshotId: true },
      // `as string[]`: because prisma type unnecessarily takes a mutable array.
      where: uniqueUserFavorites({ in: screenshotIds as string[] }, creator)
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
    const existingFavorite = await this.prisma.favorite.findFirst({
      select: { id: true },
      where: uniqueUserFavorites(screenshotId, creator)
    });

    // If the user has already favorited this screenshot, throw an error.
    if (existingFavorite) {
      throw new AlreadyInFavoritesError();
    }

    // Increment the favorite count of the screenshot.
    await this.prisma.screenshot.update({
      where: { id: screenshotId },
      data: {
        // Favoriting percentage will be updated in a background job.
        favoritesCount: { increment: 1 }
      }
    });

    // Create a new favorite.
    const favorite = await this.prisma.favorite.create({
      data: {
        screenshotId,
        creatorId: creator.id,
        ip: nn(creator.ips[0]),
        hwid: creator.hwids[0] ?? null
      }
    });

    // Update stats.
    this.screenshotStatsService.requestStatsUpdate(screenshotId);

    return favorite;
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
    const existingFavorite = await this.prisma.favorite.findFirst({
      where: uniqueUserFavorites(screenshotId, creator)
    });

    // If the user has not favorited this screenshot, throw an error.
    if (!existingFavorite) {
      throw new NotInFavoritesError();
    }

    // Remove the favorite.
    const favorite = this.prisma.favorite.delete({
      where: { id: existingFavorite.id }
    });

    // Update stats.
    this.screenshotStatsService.requestStatsUpdate(screenshotId);

    return favorite;
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

/**
 * Matches the favorites a unique user left on the given screenshots.
 * Multi-accounting is not allowed for favorites, so a favorite is shared by every account on any of
 * the creator's hardware IDs or IPs, hence the OR clause.
 */
function uniqueUserFavorites(
  screenshotId: NonNullable<Prisma.FavoriteWhereInput['screenshotId']>,
  creator: Pick<Creator, 'id' | 'hwids' | 'ips'>
): Prisma.FavoriteWhereInput {
  return {
    OR: [
      { screenshotId, creatorId: creator.id },
      { screenshotId, hwid: { in: creator.hwids } },
      { screenshotId, ip: { in: creator.ips } }
    ]
  };
}

export abstract class FavoriteError extends StandardError {}

export class NotInFavoritesError extends FavoriteError {
  public override httpErrorType = BadRequestException;

  public constructor(options?: ErrorOptions) {
    super(`You have not favorited this screenshot.`, options);
  }
}

export class AlreadyInFavoritesError extends FavoriteError {
  public override httpErrorType = BadRequestException;

  public constructor(options?: ErrorOptions) {
    super(`You have already favorited this screenshot.`, options);
  }
}
