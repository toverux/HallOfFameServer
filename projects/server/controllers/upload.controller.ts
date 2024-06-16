import assert from 'node:assert/strict';
import {
    BadRequestException,
    Controller,
    Inject,
    Post,
    Req
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ScreenshotProcessingService } from '../services';

@Controller('api/upload')
export class UploadController {
    @Inject(ScreenshotProcessingService)
    private readonly screenshotProcessingService!: ScreenshotProcessingService;

    /**
     * Receives a screenshot and its metadata and processes it to add it to the
     * Hall of Fame.
     *
     * Expects a multipart request with the following fields:
     * - `creatorId`: The Creator ID.
     * - `creatorName`: The Creator Name, required but can be empty, then
     *    defaults to 'Anonymous'.
     * - `cityName`: The name of the city.
     * - `cityPopulation`: The population of the city.
     * - `screenshot`: The screenshot file, a JPEG.
     *
     * Response will be 201 without body.
     */
    @Post()
    public async upload(@Req() req: FastifyRequest) {
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

        const creatorId = getMultipartString('creatorId', false);
        const creatorName = getMultipartString('creatorName', true);
        const cityName = getMultipartString('cityName', false);
        const cityPopulation = Number.parseInt(
            getMultipartString('cityPopulation', false),
            10
        );

        if (Number.isNaN(cityPopulation)) {
            throw new BadRequestException(
                `Expected a valid integer number for the field 'cityPopulation'.`
            );
        }

        try {
            const fileBuffer = await uploadedFile.toBuffer();

            const { imageFHDBuffer, image4KBuffer } =
                await this.screenshotProcessingService.processScreenshot(
                    fileBuffer,
                    { creatorName, cityName }
                );

            // @todo Remove later
            console.debug('creatorId:', creatorId);
            console.debug('FHD:', imageFHDBuffer.length);
            console.debug('4K:', image4KBuffer.length);
        } catch (ex) {
            if (ex instanceof Error && ex.message.includes('format')) {
                throw new BadRequestException(`Invalid image format.`, {
                    cause: ex
                });
            }

            throw ex;
        }

        function getMultipartString<TAllowEmpty extends boolean>(
            fieldName: string,
            allowEmpty: TAllowEmpty
        ): TAllowEmpty extends false ? string : string | null {
            assert(uploadedFile, 'Called too soon!');

            const field = uploadedFile.fields[fieldName];

            if (
                !(field && 'value' in field && typeof field.value == 'string')
            ) {
                throw new BadRequestException(
                    `Expected a multipart field named '${fieldName}'.`
                );
            }

            const value = field.value.trim();

            // biome-ignore lint/complexity/useSimplifiedLogicExpression: simple
            if (!allowEmpty && !value) {
                throw new BadRequestException(
                    `Expected a non-empty string for the field '${fieldName}'.`
                );
            }

            return value || (null as TAllowEmpty extends false ? string : null);
        }
    }
}
