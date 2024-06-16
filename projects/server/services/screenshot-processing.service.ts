import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import Bun from 'bun';
import * as dateFns from 'date-fns';
import sharp from 'sharp';

interface ScreenshotMetadata {
    creatorName: string | null;
    cityName: string;
}

@Injectable()
export class ScreenshotProcessingService {
    private static readonly debugImagesDir = path.join(
        import.meta.dir,
        '../../../test'
    );

    public async processScreenshot(
        buffer: Buffer,
        { creatorName, cityName }: ScreenshotMetadata
    ): Promise<{
        imageFHDBuffer: Buffer;
        image4KBuffer: Buffer;
    }> {
        const image = sharp(buffer)
            // Use well-known and standard EXIF fields.
            // https://exiftool.org/TagNames/EXIF.html
            .withExif({
                // biome-ignore lint/style/useNamingConvention: EXIF Standard
                IFD0: {
                    // biome-ignore lint/style/useNamingConvention: EXIF Standard
                    Software: 'Cities: Skylines II, Hall of Fame Mod',
                    // biome-ignore lint/style/useNamingConvention: EXIF Standard
                    Artist: creatorName ?? 'Anonymous',
                    // biome-ignore lint/style/useNamingConvention: EXIF Standard
                    ImageDescription: cityName,
                    // Must respect a specific format for EXIF dates.
                    // biome-ignore lint/style/useNamingConvention: EXIF Standard
                    DateTime: dateFns.format(new Date(), 'yyyy:MM:dd hh:mm:ss')
                }
            })
            // We want to minimize the size of the image as much as possible
            // while keeping the quality as high as possible.
            // The mozjpeg preset already does a very great job, and a quality
            // of 70 seemed to be the threshold before the image really started
            // to lose quality (especially the palette).
            // mozjpeg also produces progressive JPEGs.
            .jpeg({ force: true, quality: 70, mozjpeg: true });

        // Resize to 4K and Full HD-like resolutions but keep the aspect ratio,
        // allowing overflow so the dimensions specified are a minimum.
        // Ex. A 1:1 image of 4000x4000 will be resized to 3840x3840.
        const imageFHD = image.clone().resize(1920, 1080, { fit: 'outside' });
        const image4K = image.clone().resize(3840, 2160, { fit: 'outside' });

        const imageFHDBuffer = await imageFHD.toBuffer();
        const image4KBuffer = await image4K.toBuffer();

        // Write debug images to the test directory.
        if (process.env.NODE_ENV == 'development') {
            await this.writeDebugImages({
                // Also save a non-resized version of the image, useful to test
                // compression settings.
                'noresize': await image.toBuffer(),
                'fhd': imageFHDBuffer,
                '4k': image4KBuffer
            });
        }

        return { imageFHDBuffer, image4KBuffer };
    }

    private async writeDebugImages(
        images: Record<string, Buffer>
    ): Promise<void> {
        const results = await Promise.allSettled(
            Object.entries(images).map(([name, buffer]) => {
                const imagePath = path.join(
                    ScreenshotProcessingService.debugImagesDir,
                    `screenshot-${name}.jpg`
                );

                return Bun.write(imagePath, buffer);
            })
        );

        const failed = results.find(
            (result): result is PromiseRejectedResult =>
                result.status == 'rejected'
        );

        if (failed) {
            throw failed.reason;
        }
    }
}
