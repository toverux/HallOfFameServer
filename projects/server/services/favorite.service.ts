import { Inject, Injectable } from '@nestjs/common';
import { Creator, Favorite, Screenshot } from '@prisma/client';
import { HardwareID, IPAddress, JsonObject, StandardError } from '../common';
import { PrismaService } from './prisma.service';

@Injectable()
export class FavoriteService {
    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    /**
     * Checks if a screenshot is favorited by a unique user.
     */
    public async isFavorite(
        screenshotId: Screenshot['id'],
        creatorId: Creator['id'],
        ip: IPAddress,
        hwid: HardwareID
    ): Promise<boolean> {
        // Find a favorite with any of the provided identifiers,
        // multi-accounting is not allowed for favorites so a favorite is shared
        // by any of these, hence the OR clause.
        const favorite = await this.prisma.favorite.findFirst({
            select: { id: true },
            where: {
                // biome-ignore lint/style/useNamingConvention: prisma
                OR: [
                    { screenshotId, creatorId },
                    { screenshotId, hwid },
                    ...(ip.startsWith('172') ? [] : [{ screenshotId, ip }])
                ]
            }
        });

        return favorite != null;
    }

    /**
     * Adds a favorite to a screenshot.
     */
    public async addFavorite(
        screenshotId: Screenshot['id'],
        creatorId: Creator['id'],
        ip: IPAddress,
        hwid: HardwareID
    ): Promise<Favorite> {
        // Check if the user has already favorited this screenshot.
        // We can't use .findUnique() because of the OR clause.
        // The compound indexes [creatorId, screenshotId], etc. are still used!
        const favorite = await this.prisma.favorite.findFirst({
            select: { id: true },
            where: {
                // biome-ignore lint/style/useNamingConvention: prisma
                OR: [
                    { screenshotId, creatorId },
                    { screenshotId, hwid },
                    ...(ip.startsWith('172') ? [] : [{ screenshotId, ip }])
                ]
            }
        });

        // If the user has already favorited this screenshot, throw an error.
        if (favorite) {
            throw new AlreadyInFavoritesError();
        }

        // Increment the favorites count of the screenshot.
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
                creatorId,
                ip,
                hwid
            }
        });
    }

    /**
     * Removes a favorite from a screenshot.
     */
    public async removeFavorite(
        screenshotId: Screenshot['id'],
        creatorId: Creator['id'],
        ip: IPAddress,
        hwid: HardwareID
    ): Promise<Favorite> {
        // Find the favorite to remove.
        // We can't use .remove() directly because we can't use .remove() which
        // requires a where clause that guarantees uniqueness, but we use an OR
        // clause.
        const favorite = await this.prisma.favorite.findFirst({
            where: {
                // biome-ignore lint/style/useNamingConvention: prisma
                OR: [
                    { screenshotId, creatorId },
                    { screenshotId, hwid },
                    ...(ip.startsWith('172') ? [] : [{ screenshotId, ip }])
                ]
            }
        });

        // If the user has not favorited this screenshot, throw an error.
        if (!favorite) {
            throw new NotInFavoritesError();
        }

        // Decrement the favorites count of the screenshot.
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
    public serialize(favorite: Favorite): JsonObject {
        return {
            id: favorite.id,
            favoritedAt: favorite.favoritedAt.toISOString(),
            creatorId: favorite.creatorId,
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
