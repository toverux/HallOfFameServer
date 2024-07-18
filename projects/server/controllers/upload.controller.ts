import { Multipart } from '@fastify/multipart';
import {
    BadRequestException,
    Controller,
    ForbiddenException,
    Inject,
    Post,
    Req
} from '@nestjs/common';
import { oneLine } from 'common-tags';
import type { FastifyRequest } from 'fastify';
import {
    CreatorService,
    CreatorServiceError,
    InvalidCreatorIdError,
    ScreenshotService
} from '../services';

@Controller('api/upload')
export class UploadController {
    /**
     * Regular expression to validate Creator or City names.
     * @private
     */
    private static readonly nameRegex = /^[\p{L}\p{N}\- ']{2,25}$/u;

    @Inject(CreatorService)
    private readonly creatorService!: CreatorService;

    @Inject(ScreenshotService)
    private readonly screenshotService!: ScreenshotService;

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
    @Post()
    public async upload(@Req() req: FastifyRequest) {
        // We need to retrieve the IP address before consuming the body, or it
        // becomes undefined.
        const ip = req.ip;

        const multipart = await req.file({
            isPartAFile: fieldName => fieldName == 'screenshot',
            limits: {
                fields: 5,
                fieldSize: 1024,
                fileSize: 5 * 1024 * 1024
            }
        });

        if (!multipart) {
            throw new BadRequestException(
                `Expected a file-field named 'screenshot'.`
            );
        }

        const getString = this.getMultipartString.bind(this, multipart);

        const creatorId = getString('creatorId');

        const creatorName = UploadController.validateName(
            'Creator Name',
            getString('creatorName')
        );

        const cityName = UploadController.validateName(
            'City Name',
            getString('cityName')
        );

        const cityPopulation = UploadController.validatePopulation(
            getString('cityPopulation')
        );

        try {
            // Get or create the creator.
            const creator = await this.creatorService.getOrCreateCreator(
                creatorId,
                creatorName,
                ip
            );

            const fileBuffer = await multipart.toBuffer();

            const screenshot = await this.screenshotService.ingestScreenshot(
                creator,
                cityName,
                cityPopulation,
                fileBuffer
            );

            return this.screenshotService.serialize(screenshot);
        } catch (error) {
            if (error instanceof Error && error.message.includes('format')) {
                throw new BadRequestException(`Invalid image format.`, {
                    cause: error
                });
            }

            if (error instanceof InvalidCreatorIdError) {
                throw new ForbiddenException(error.message, { cause: error });
            }

            if (error instanceof CreatorServiceError) {
                throw new BadRequestException(error.message, { cause: error });
            }

            throw error;
        }
    }

    private getMultipartString(
        multipart: Multipart,
        fieldName: string
    ): string {
        const field = multipart.fields[fieldName];

        if (!(field && 'value' in field)) {
            throw new BadRequestException(
                `Expected a multipart field named '${fieldName}'.`
            );
        }

        const value = String(field.value).trim();

        if (!value) {
            throw new BadRequestException(
                `Expected a non-empty string for the field '${fieldName}'.`
            );
        }

        return value;
    }

    private static validateName(what: string, name: string): string {
        if (!name.match(UploadController.nameRegex)) {
            throw new BadRequestException(oneLine`
                Invalid ${what}, it must contain only letters, numbers,
                spaces, hyphens and apostrophes, and be between 2 and 25
                characters long.`);
        }

        return name;
    }

    private static validatePopulation(population: string): number {
        const parsed = Number.parseInt(population, 10);

        if (Number.isNaN(parsed) || parsed < 0 || parsed > 5_000_000) {
            throw new BadRequestException(
                `Invalid population number, it must be a positive integer.`
            );
        }

        return parsed;
    }
}
