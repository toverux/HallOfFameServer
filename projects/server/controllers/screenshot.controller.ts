import { Multipart } from '@fastify/multipart';
import {
    Controller,
    Get,
    Headers,
    Inject,
    Ip,
    ParseBoolPipe,
    ParseIntPipe,
    Post,
    Query,
    Req
} from '@nestjs/common';
import { oneLine } from 'common-tags';
import type { FastifyRequest } from 'fastify';
import type { CreatorID } from '../common';
import { type IPAddress, type JSONObject, StandardError } from '../common';
import { BanService, CreatorService, ScreenshotService } from '../services';

@Controller('api/screenshot')
export class ScreenshotController {
    /**
     * Regular expression to validate Creator or City names.
     */
    private static readonly nameRegex = /^[\p{L}\p{N}\- ']{2,25}$/u;

    @Inject(CreatorService)
    private readonly creatorService!: CreatorService;

    @Inject(ScreenshotService)
    private readonly screenshotService!: ScreenshotService;

    @Inject(BanService)
    private readonly banService!: BanService;

    /**
     * Returns a random screenshot.
     * Different algorithms can be used to select the screenshot randomly, to
     * each algorithm a weight can be assigned to favor one method over others.
     * See {@link ScreenshotService} for the description of the algorithms.
     * By default, all weights are zero and "random" is used.
     *
     * @param ipAddress     The IP address for view tracking.
     * @param authorization The CreatorID Authorization header for more accurate
     *                      view tracking. Optional, its role is to avoid
     *                      creating an account for people who have never posted
     *                      and are just browsing.
     * @param random        Weight for the "random" algorithm, see
     *                      {@link ScreenshotService.getRandomScreenshot}.
     * @param recent        Weight for the "recent" algorithm, see
     *                      {@link ScreenshotService.getRecentScreenshot}.
     * @param lowViews      Weight for the "lowViews" algorithm, see
     *                      {@link ScreenshotService.getLowViewsScreenshot}.
     * @param markViewed    Whether to mark the screenshot as viewed: increment
     *                      view count and add a View record. Default is true.
     * @param viewMaxAge    Min time in days before showing a screenshot the
     *                      user has already seen. Default is 60, 0 is no limit.
     */
    @Get('weighted')
    public async weighted(
        @Ip()
        ipAddress: IPAddress,
        @Headers('Authorization')
        authorization: string | undefined,
        @Query('random', new ParseIntPipe({ optional: true }))
        random = 0,
        @Query('recent', new ParseIntPipe({ optional: true }))
        recent = 0,
        @Query('lowViews', new ParseIntPipe({ optional: true }))
        lowViews = 0,
        @Query('markViewed', new ParseBoolPipe({ optional: true }))
        markViewed = true,
        @Query('viewMaxAge', new ParseIntPipe({ optional: true }))
        viewMaxAge = 60
    ) {
        const weights = { random, recent, lowViews };

        const creatorId = authorization
            ? ScreenshotController.getCreatorId(authorization)
            : undefined;

        const screenshot =
            await this.screenshotService.getWeightedRandomScreenshot(
                weights,
                markViewed,
                ipAddress,
                creatorId,
                viewMaxAge
            );

        return {
            __algorithm: screenshot.__algorithm,
            ...this.screenshotService.serialize(screenshot)
        };
    }

    /**
     * Receives a screenshot and its metadata and processes it to add it to the
     * Hall of Fame.
     *
     * Expects a multipart request with the following fields:
     * - `creatorId`: The Creator ID.
     * - `creatorName`: The Creator Name.
     * - `cityName`: The name of the city.
     * - `cityPopulation`: The population of the city.
     * - `screenshot`: The screenshot file, a JPEG.
     *
     * Response will be 201 with serialized Screenshot.
     */
    @Post('upload')
    public async upload(
        @Req()
        req: FastifyRequest,
        @Ip()
        ipAddress: IPAddress,
        @Headers('Authorization')
        authorization: string | undefined
    ): Promise<JSONObject> {
        await this.banService.ensureIpAddressNotBanned(ipAddress);

        const multipart = await req.file({
            isPartAFile: fieldName => fieldName == 'screenshot',
            limits: {
                fields: 5,
                fieldSize: 1024,
                fileSize: 5 * 1024 * 1024
            }
        });

        if (!multipart) {
            throw new InvalidPayloadError(
                `Expected a file-field named 'screenshot'.`
            );
        }

        const creatorId = ScreenshotController.getCreatorId(authorization);

        const getString = ScreenshotController.getMultipartString.bind(
            this,
            multipart
        );

        const creatorName = ScreenshotController.validateName(
            getString('creatorName')
        );

        const cityName = ScreenshotController.validateName(
            getString('cityName')
        );

        const cityPopulation = ScreenshotController.validatePopulation(
            getString('cityPopulation')
        );

        try {
            // Get or create the creator.
            const creator = await this.creatorService.getOrCreateCreator(
                creatorId,
                creatorName,
                ipAddress
            );

            await this.banService.ensureCreatorNotBanned(creator);

            const fileBuffer = await multipart.toBuffer();

            const screenshot = await this.screenshotService.ingestScreenshot(
                ipAddress,
                creator,
                cityName,
                cityPopulation,
                fileBuffer
            );

            return this.screenshotService.serialize(screenshot);
        } catch (error) {
            if (error instanceof Error && error.message.includes('format')) {
                throw new InvalidImageFormatError(error);
            }

            throw error;
        }
    }

    private static getCreatorId(authorization: string | undefined): CreatorID {
        const [scheme, creatorId, rest] = authorization?.split(' ') ?? [];

        if (scheme?.toLowerCase() != 'creatorid' || !creatorId || rest) {
            throw new InvalidPayloadError(
                `Expected an Authorization header of format CreatorID YOUR-UUID`
            );
        }

        return CreatorService.validateCreatorId(creatorId);
    }

    private static getMultipartString(
        multipart: Multipart,
        fieldName: string
    ): string {
        const field = multipart.fields[fieldName];

        if (!(field && 'value' in field)) {
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

    private static validateName(name: string): string {
        if (!name.match(ScreenshotController.nameRegex)) {
            throw new InvalidNameError(name);
        }

        return name;
    }

    private static validatePopulation(population: string): number {
        const parsed = Number.parseInt(population, 10);

        if (Number.isNaN(parsed) || parsed < 0 || parsed > 5_000_000) {
            throw new InvalidPayloadError(
                `Invalid population number, it must be a positive integer.`
            );
        }

        return parsed;
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

class InvalidNameError extends UploadError {
    public constructor(public readonly incorrectName: string) {
        super(oneLine`
            Name "${incorrectName}" is invalid, it must contain only letters,
            numbers, spaces, hyphens and apostrophes, and be between 2 and 25
            characters long.`);
    }
}

class InvalidImageFormatError extends UploadError {
    public constructor(cause: unknown) {
        super(`Invalid image format, expected a JPEG file.`, { cause });
    }
}
