import { Multipart } from '@fastify/multipart';
import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Inject,
    Ip,
    ParseBoolPipe,
    ParseIntPipe,
    Post,
    Query,
    Req,
    UseGuards
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { oneLine } from 'common-tags';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type IPAddress, type JsonObject, StandardError } from '../../common';
import { CreatorAuthorizationGuard } from '../../guards';
import { ZodParsePipe } from '../../pipes';
import { BanService, ScreenshotService } from '../../services';

@Controller('screenshot')
@UseGuards(CreatorAuthorizationGuard)
export class ScreenshotController {
    /**
     * Regular expression to validate a city name:
     * - Must contain only letters, numbers, spaces, hyphens and apostrophes.
     * - Must be between 2 and 25 characters long.
     */
    private static readonly cityNameRegex = /^[\p{L}\- ']{2,25}$/u;

    /** @see report */
    private static readonly postReportBodySchema = z
        .object({
            screenshotId: z.string().length(24)
        })
        .required();

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
     * @param req           The request object.
     * @param random        Weight for the "random" algorithm, see
     *                      {@link ScreenshotService.getScreenshotRandom}.
     * @param recent        Weight for the "recent" algorithm, see
     *                      {@link ScreenshotService.getScreenshotRecent}.
     * @param archeologist  Weight for the "archeologist" algorithm, see
     *                      {@link ScreenshotService.getScreenshotArcheologist}.
     * @param supporter     Weight for the "supporter" algorithm, see
     *                      {@link ScreenshotService.getScreenshotSupporter}.
     * @param markViewed    Whether to mark the screenshot as viewed: increment
     *                      view count and add a View record. Default is true.
     * @param viewMaxAge    Min time in days before showing a screenshot the
     *                      user has already seen. Default is 60, 0 is no limit.
     */
    @Get('weighted')
    public async weighted(
        @Req()
        req: FastifyRequest,
        @Query('random', new ParseIntPipe({ optional: true }))
        random = 0,
        @Query('recent', new ParseIntPipe({ optional: true }))
        recent = 0,
        @Query('archeologist', new ParseIntPipe({ optional: true }))
        archeologist = 0,
        @Query('supporter', new ParseIntPipe({ optional: true }))
        supporter = 0,
        @Query('markViewed', new ParseBoolPipe({ optional: true }))
        markViewed = true,
        @Query('viewMaxAge', new ParseIntPipe({ optional: true }))
        viewMaxAge = 60
    ) {
        const creator = CreatorAuthorizationGuard.getAuthenticatedCreator(req);

        const weights = { random, recent, archeologist, supporter };

        const screenshot =
            await this.screenshotService.getWeightedRandomScreenshot(
                weights,
                markViewed,
                creator.id,
                viewMaxAge
            );

        return {
            __algorithm: screenshot.__algorithm,
            ...this.screenshotService.serialize({ ...screenshot, creator })
        };
    }

    /**
     * Reports a screenshot as inappropriate.
     *
     * ###### Implementation notes
     * The body is a zod-validated object, this might seem overkill for just one
     * field, but we will probably have more fields in the future (ex. what is
     * the nature of the issue, a comment, etc.), so the groundwork is there.
     */
    @Post('report')
    public async report(
        @Ip()
        ipAddress: IPAddress,
        @Body(new ZodParsePipe(ScreenshotController.postReportBodySchema))
        body: z.infer<typeof ScreenshotController.postReportBodySchema>
    ): Promise<JsonObject> {
        try {
            const screenshot = await this.screenshotService.markReported(
                body.screenshotId,
                ipAddress
            );

            return this.screenshotService.serialize(screenshot);
        } catch (error) {
            if (
                error instanceof PrismaClientKnownRequestError &&
                error.code == 'P2025'
            ) {
                throw new BadRequestException(
                    `Could not find screenshot #${body.screenshotId}.`,
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
     * - `creatorName`: The Creator Name.
     * - `cityName`: The name of the city.
     * - `cityMilestone`: The milestone reached by the city.
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
        ipAddress: IPAddress
    ): Promise<JsonObject> {
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

        const getString = ScreenshotController.getMultipartString.bind(
            this,
            multipart
        );

        const cityName = ScreenshotController.validateCityName(
            getString('cityName')
        );

        const cityMilestone = ScreenshotController.validateMilestone(
            getString('cityMilestone')
        );

        const cityPopulation = ScreenshotController.validatePopulation(
            getString('cityPopulation')
        );

        try {
            const creator =
                CreatorAuthorizationGuard.getAuthenticatedCreator(req);

            await this.banService.ensureCreatorNotBanned(creator);

            const fileBuffer = await multipart.toBuffer();

            const screenshot = await this.screenshotService.ingestScreenshot(
                ipAddress,
                creator,
                cityName,
                cityMilestone,
                cityPopulation,
                new Date(),
                fileBuffer
            );

            return this.screenshotService.serialize({ ...screenshot, creator });
        } catch (error) {
            if (error instanceof Error && error.message.includes('format')) {
                throw new InvalidImageFormatError(error);
            }

            throw error;
        }
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

    private static validateCityName(name: string): string {
        if (!name.match(ScreenshotController.cityNameRegex)) {
            throw new InvalidCityNameError(name);
        }

        return name;
    }

    private static validateMilestone(milestone: string): number {
        const parsed = Number.parseInt(milestone, 10);

        if (Number.isNaN(parsed) || parsed < 0 || parsed > 20) {
            throw new InvalidPayloadError(
                `Invalid milestone, it must be a positive integer between 0 and 20.`
            );
        }

        return parsed;
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

class InvalidCityNameError extends UploadError {
    public constructor(public readonly incorrectName: string) {
        super(oneLine`
            City name "${incorrectName}" is invalid, it must contain only
            letters, numbers, spaces, hyphens and apostrophes, and be between 2
            and 25 characters long.`);
    }
}

class InvalidImageFormatError extends UploadError {
    public constructor(cause: unknown) {
        super(`Invalid image format, expected a JPEG file.`, { cause });
    }
}
