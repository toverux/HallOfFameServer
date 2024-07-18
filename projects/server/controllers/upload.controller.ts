import assert from 'node:assert/strict';
import {
    BadRequestException,
    Controller,
    ForbiddenException,
    Inject,
    Post,
    Req
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
    CreatorService,
    CreatorServiceError,
    InvalidCreatorIdError,
    ScreenshotService
} from '../services';

@Controller('api/upload')
export class UploadController {
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

        const uploadedFile = await req.file({
            isPartAFile: fieldName => fieldName == 'screenshot',
            limits: {
                fields: 5,
                fieldSize: 1024,
                fileSize: 5 * 1024 * 1024
            }
        });

        if (!uploadedFile) {
            throw new BadRequestException(
                `Expected a file-field named 'screenshot'.`
            );
        }

        const creatorId = getMultipartString('creatorId');
        const creatorName = getMultipartString('creatorName');
        const cityName = getMultipartString('cityName');
        const cityPopulation = Number.parseInt(
            getMultipartString('cityPopulation'),
            10
        );

        if (Number.isNaN(cityPopulation)) {
            throw new BadRequestException(
                `Expected a valid integer number for the field 'cityPopulation'.`
            );
        }

        try {
            // Get or create the creator.
            const creator = await this.creatorService.getOrCreateCreator(
                creatorId,
                creatorName,
                ip
            );

            const fileBuffer = await uploadedFile.toBuffer();

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

        function getMultipartString(fieldName: string): string {
            assert(uploadedFile, 'Called too soon!');

            const field = uploadedFile.fields[fieldName];

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
    }
}
