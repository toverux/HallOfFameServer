import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import Bun from 'bun';
import * as dateFns from 'date-fns';
import sharp from 'sharp';
import { allFulfilled } from '../../shared/utils/all-fulfilled';
import type { Maybe } from '../../shared/utils/utility-types';
import { config } from '../config';

@Injectable()
export class ScreenshotProcessingService {
  private static readonly debugImagesDir = path.join(import.meta.dir, '../../../test');

  public async resizeScreenshots(
    imageData: Buffer,
    metadata: { creatorName: Maybe<string>; cityName: string }
  ): Promise<{
    imageThumbnailBuffer: Buffer;
    imageFhdBuffer: Buffer;
    image4kBuffer: Buffer;
  }> {
    const image = sharp(imageData)
      // Use well-known and standard EXIF fields.
      // https://exiftool.org/TagNames/EXIF.html
      .withExif({
        // biome-ignore lint/style/useNamingConvention: EXIF Standard
        IFD0: {
          // biome-ignore lint/style/useNamingConvention: EXIF Standard
          Software: 'Cities: Skylines II, Hall of Fame Mod',
          // biome-ignore lint/style/useNamingConvention: EXIF Standard
          Artist: metadata.creatorName ?? 'Anonymous',
          // biome-ignore lint/style/useNamingConvention: EXIF Standard
          ImageDescription: metadata.cityName,
          // Must respect a specific format for EXIF dates.
          // biome-ignore lint/style/useNamingConvention: EXIF Standard
          DateTime: dateFns.format(new Date(), 'yyyy:MM:dd hh:mm:ss')
        }
      })
      // We want to minimize the size of the image as much as possible while keeping the quality as
      // high as possible.
      // The mozjpeg preset already does a very great job, and a quality of 85 seemed to be an
      // acceptable tradeoff between quality and size (even 70 was fine on small display, but on
      // large displays, artifacts were too prominent).
      // Mozjpeg also produces progressive JPEGs.
      .jpeg({
        force: true,
        quality: config.screenshots.jpegQuality,
        mozjpeg: true
      });

    // Resize to Thumbnail, 4K and Full HD-like resolutions but keep the aspect ratio, allowing
    // overflow so the dimensions specified are a minimum.
    // Ex. A 1:1 image of 4000x4000 will be resized to 3840x3840.
    const options: sharp.ResizeOptions = {
      fit: 'outside',
      withoutEnlargement: true
    };

    const imageThumbnail = image.clone().resize(256, 144, options);
    const imageFhd = image.clone().resize(1920, 1080, options);
    const image4k = image.clone().resize(3840, 2160, options);

    // Wait for all images to be processed.
    const [imageThumbnailBuffer, imageFhdBuffer, image4kBuffer] = await allFulfilled([
      imageThumbnail.toBuffer(),
      imageFhd.toBuffer(),
      image4k.toBuffer()
    ]);

    // Write debug images to the test directory.
    if (config.env == 'development') {
      await allFulfilled(
        Object.entries({
          // Also save a non-resized version of the image, useful to test compression settings.
          'noresize': await image.toBuffer(),
          'thumbnail': imageThumbnailBuffer,
          'fhd': imageFhdBuffer,
          '4k': image4kBuffer
        }).map(([name, buffer]) => {
          const imagePath = path.join(
            ScreenshotProcessingService.debugImagesDir,
            `screenshot-${name}.jpg`
          );

          return Bun.write(imagePath, buffer.buffer);
        })
      );
    }

    return { imageThumbnailBuffer, imageFhdBuffer, image4kBuffer };
  }
}
