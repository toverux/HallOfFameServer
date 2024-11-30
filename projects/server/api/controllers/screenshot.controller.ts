import assert from 'node:assert/strict';
import { Multipart } from '@fastify/multipart';
import {
    BadRequestException,
    Controller,
    Delete,
    Get,
    Inject,
    Ip,
    NotFoundException,
    Param,
    ParseIntPipe,
    Post,
    Query,
    Req,
    UseGuards
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { oneLine } from 'common-tags';
import type { FastifyRequest } from 'fastify';
import { type IPAddress, JsonObject, StandardError } from '../../common';
import { CreatorAuthorizationGuard } from '../../guards';
import {
    FavoriteService,
    PrismaService,
    ScreenshotService,
    ViewService
} from '../../services';

@Controller('screenshots')
@UseGuards(CreatorAuthorizationGuard)
export class ScreenshotController {
    /**
     * Regular expression to validate a city name:
     * - Must contain only letters, numbers, spaces, hyphens, apostrophes and
     *   commas.
     * - Must be between 1 and 25 characters long. 1-character-long names are
     *   for languages like Chinese.
     */
    private static readonly cityNameRegex = /^[\p{L}\p{N}\- ',]{1,25}$/u;

    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    @Inject(FavoriteService)
    private readonly favoriteService!: FavoriteService;

    @Inject(ScreenshotService)
    private readonly screenshotService!: ScreenshotService;

    @Inject(ViewService)
    private readonly viewService!: ViewService;

    /**
     * Returns a single screenshot by its ID.
     */
    @Get(':id')
    public async getOne(
        @Req() req: FastifyRequest,
        @Param('id') id: string
    ): Promise<JsonObject> {
        const authed = req[CreatorAuthorizationGuard.authenticatedCreatorKey];

        const screenshot = await this.prisma.screenshot.findUnique({
            where: { id },
            include: { creator: true }
        });

        if (!screenshot) {
            throw new NotFoundException(`Could not find Screenshot #${id}.`);
        }

        const payload = this.screenshotService.serialize(screenshot, req);

        // If the user is authenticated, we check if the screenshot is already
        // in their favorites. Otherwise, just set it to false.
        payload.__favorited =
            !!authed &&
            (await this.favoriteService.isFavorite(
                screenshot.id,
                authed.creator.id,
                authed.authorization.ip,
                authed.authorization.hwid
            ));

        return payload;
    }

    /**
     * Returns a random screenshot.
     * Different algorithms can be used to select the screenshot randomly, to
     * each algorithm a weight can be assigned to favor one method over others.
     * See {@link ScreenshotService} for the description of the algorithms.
     * By default, all weights are zero and "random" is used.
     *
     * @param req           The request object.
     * @param random        Weight for the "random" algorithm, see
     *                      {@link ScreenshotService.getScreenshotRandom}.
     * @param trending      Weight for the "trending" algorithm, see
     *                      {@link ScreenshotService.getScreenshotTrending}.
     * @param recent        Weight for the "recent" algorithm, see
     *                      {@link ScreenshotService.getScreenshotRecent}.
     * @param archeologist  Weight for the "archeologist" algorithm, see
     *                      {@link ScreenshotService.getScreenshotArcheologist}.
     * @param supporter     Weight for the "supporter" algorithm, see
     *                      {@link ScreenshotService.getScreenshotSupporter}.
     * @param viewMaxAge    Min time in days before showing a screenshot the
     *                      user has already seen. Default is 60, 0 is no limit.
     */
    @Get('weighted')
    public async getRandomWeighted(
        @Req()
        req: FastifyRequest,
        @Query('random', new ParseIntPipe({ optional: true }))
        random = 0,
        @Query('trending', new ParseIntPipe({ optional: true }))
        trending = 0,
        @Query('recent', new ParseIntPipe({ optional: true }))
        recent = 0,
        @Query('archeologist', new ParseIntPipe({ optional: true }))
        archeologist = 0,
        @Query('supporter', new ParseIntPipe({ optional: true }))
        supporter = 0,
        @Query('viewMaxAge', new ParseIntPipe({ optional: true }))
        viewMaxAge = 60
    ) {
        const authed = req[CreatorAuthorizationGuard.authenticatedCreatorKey];

        const weights = { random, trending, recent, archeologist, supporter };

        const screenshot =
            await this.screenshotService.getWeightedRandomScreenshot(
                weights,
                authed?.creator.id,
                viewMaxAge
            );

        const createdBy = await this.prisma.creator.findFirst({
            where: { id: screenshot.creatorId }
        });

        assert(createdBy, `Could not find Creator #${screenshot.creatorId}`);

        const payload = this.screenshotService.serialize(
            {
                ...screenshot,
                creator: createdBy
            },
            req
        );

        payload.__algorithm = screenshot.__algorithm;

        // If the user is authenticated, we check if the screenshot is already
        // in their favorites. Otherwise, just set it to false.
        payload.__favorited =
            !!authed &&
            (await this.favoriteService.isFavorite(
                screenshot.id,
                authed.creator.id,
                authed.authorization.ip,
                authed.authorization.hwid
            ));

        return payload;
    }

    /**
     * Adds the screenshot to the authenticated creator's favorites.
     * We also verify that the screenshot was not already favorites using a same
     * IP or HWID, as multi-accounting on favorites is not allowed.
     */
    @Post(':id/favorites')
    public async addToFavorites(
        @Req() req: FastifyRequest,
        @Param('id') screenshotId: string
    ): Promise<JsonObject> {
        const authed = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

        const favorite = await this.favoriteService.addFavorite(
            screenshotId,
            authed.creator.id,
            authed.authorization.ip,
            authed.authorization.hwid
        );

        return this.favoriteService.serialize(favorite);
    }

    /**
     * Deletes the screenshot from the authenticated creator's favorites.
     */
    @Delete(':id/favorites/mine')
    public async removeFromFavorites(
        @Req() req: FastifyRequest,
        @Param('id') screenshotId: string
    ): Promise<JsonObject> {
        const authed = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

        const favorite = await this.favoriteService.removeFavorite(
            screenshotId,
            authed.creator.id,
            authed.authorization.ip,
            authed.authorization.hwid
        );

        return this.favoriteService.serialize(favorite);
    }

    /**
     * Marks a screenshot as viewed by the authenticated creator.
     */
    @Post(':id/views')
    public async markViewed(
        @Req() req: FastifyRequest,
        @Param('id') screenshotId: string
    ): Promise<JsonObject> {
        const { creator } =
            CreatorAuthorizationGuard.getAuthenticatedCreator(req);

        const view = await this.viewService.markViewed(
            screenshotId,
            creator.id
        );

        return this.viewService.serialize(view);
    }

    /**
     * Reports a screenshot as inappropriate.
     *
     * Note: the request body is empty as of now as there are no other
     * information to transmit. This could change if we allow users to provide
     * a reason for the report.
     */
    @Post(':id/reports')
    public async report(
        @Req() req: FastifyRequest,
        @Param('id') screenshotId: string
    ): Promise<JsonObject> {
        try {
            const { creator } =
                CreatorAuthorizationGuard.getAuthenticatedCreator(req);

            const screenshot = await this.screenshotService.markReported(
                screenshotId,
                creator.id
            );

            return this.screenshotService.serialize(screenshot, req);
        } catch (error) {
            if (
                error instanceof PrismaClientKnownRequestError &&
                error.code == 'P2025'
            ) {
                throw new BadRequestException(
                    `Could not find Screenshot #${screenshotId}.`,
                    { cause: error }
                );
            }

            throw error;
        }
    }

    /**
     * Receives a screenshot and its metadata and processes it to add it to the
     * Hall of Fame.
     *
     * Expects a multipart request with the following fields:
     * - `creatorId`: The Creator ID.
     * - `cityName`: The name of the city.
     * - `cityMilestone`: The milestone reached by the city.
     * - `cityPopulation`: The population of the city.
     * - `screenshot`: The screenshot file, a JPEG.
     *
     * Response will be 201 with serialized Screenshot.
     */
    @Post()
    public async upload(
        @Ip() ip: IPAddress,
        @Req() req: FastifyRequest
    ): Promise<JsonObject> {
        const { authorization, creator } =
            CreatorAuthorizationGuard.getAuthenticatedCreator(req);

        const multipart = await req.file({
            isPartAFile: fieldName => fieldName == 'screenshot',
            limits: {
                fields: 5,
                fieldSize: 1024,
                fileSize: 30 * 1024 * 1024
            }
        });

        if (!multipart) {
            throw new InvalidPayloadError(
                `Expected a file-field named 'screenshot'.`
            );
        }

        const cityName = this.validateCityName(
            this.getMultipartString(multipart, 'cityName', true)
        );

        const cityMilestone = this.validateMilestone(
            this.getMultipartString(multipart, 'cityMilestone', true)
        );

        const cityPopulation = this.validatePopulation(
            this.getMultipartString(multipart, 'cityPopulation', true)
        );

        const metadata = this.validateMetadata(
            this.getMultipartString(multipart, 'metadata', false)
        );

        try {
            const fileBuffer = await multipart.toBuffer();

            const screenshot = await this.screenshotService.ingestScreenshot(
                authorization.hwid,
                ip,
                creator,
                cityName,
                cityMilestone,
                cityPopulation,
                metadata,
                new Date(),
                fileBuffer
            );

            return this.screenshotService.serialize(
                { ...screenshot, creator },
                req
            );
        } catch (error) {
            if (error instanceof Error && error.message.includes('format')) {
                throw new InvalidImageFormatError(error);
            }

            throw error;
        }
    }

    private getMultipartString(
        multipart: Multipart,
        fieldName: string,
        strict: true
    ): string;

    private getMultipartString(
        multipart: Multipart,
        fieldName: string,
        strict: false
    ): string | undefined;

    private getMultipartString(
        multipart: Multipart,
        fieldName: string,
        strict = true
    ): string | undefined {
        const field = multipart.fields[fieldName];

        if (!(field && 'value' in field)) {
            if (!strict) {
                return undefined;
            }

            throw new InvalidPayloadError(
                `Expected a multipart field named '${fieldName}'.`
            );
        }

        const value = String(field.value).trim();

        if (!value) {
            throw new InvalidPayloadError(
                `Expected a non-empty string for the field '${fieldName}'.`
            );
        }

        return value;
    }

    private validateCityName(name: string): string {
        if (!name.match(ScreenshotController.cityNameRegex)) {
            throw new InvalidCityNameError(name);
        }

        return name;
    }

    private validateMilestone(milestone: string): number {
        const parsed = Number.parseInt(milestone, 10);

        if (Number.isNaN(parsed) || parsed < 0 || parsed > 20) {
            throw new InvalidPayloadError(
                `Invalid milestone, it must be a positive integer between 0 and 20.`
            );
        }

        return parsed;
    }

    private validatePopulation(population: string): number {
        const parsed = Number.parseInt(population, 10);

        if (Number.isNaN(parsed) || parsed < 0 || parsed > 5_000_000) {
            throw new InvalidPayloadError(
                `Invalid population number, it must be a positive integer.`
            );
        }

        return parsed;
    }

    private validateMetadata(metadata: string | undefined): JsonObject {
        if (!metadata) {
            return {};
        }

        try {
            const json = JSON.parse(metadata);

            if (typeof json != 'object' || Array.isArray(json)) {
                // noinspection ExceptionCaughtLocallyJS
                throw new Error(`Expected a JSON object.`);
            }

            return json;
        } catch (error) {
            throw new InvalidPayloadError(
                `Invalid JSON for the metadata field.`,
                { cause: error }
            );
        }
    }
}

abstract class UploadError extends StandardError {}

/**
 * Error class for invalid payloads, but it should not happen for users using
 * the actual mod. This should only happen in testing, or eventually if people
 * want to implement a custom client in good faith, otherwise we could also ban
 * IPs with failed attempts.
 */
class InvalidPayloadError extends UploadError {}

class InvalidCityNameError extends UploadError {
    public constructor(public readonly incorrectName: string) {
        super(oneLine`
            City name "${incorrectName}" is invalid, it must contain only
            letters, numbers, spaces, hyphens and apostrophes, and be between 1
            and 25 characters long.`);
    }
}

class InvalidImageFormatError extends UploadError {
    public constructor(cause: unknown) {
        super(`Invalid image format, expected a JPEG file.`, { cause });
    }
}
