import path from 'node:path';
import { Injectable } from '@nestjs/common';
import * as Bun from 'bun';
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
        IFD0: {
          Software: 'Cities: Skylines II, Hall of Fame Mod',
          Artist: metadata.creatorName ?? 'Anonymous',
          ImageDescription: metadata.cityName,
          // Must respect a specific format for EXIF dates.
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

    // Target minimum resolutions (width x height) for each generated variant.
    const { thumbnail, fhd, fourK } = {
      thumbnail: { width: 256, height: 144 },
      fhd: { width: 1920, height: 1080 },
      fourK: { width: 3840, height: 2160 }
    };

    const imageThumbnail = image.clone().resize(thumbnail.width, thumbnail.height, options);
    const imageFhd = image.clone().resize(fhd.width, fhd.height, options);
    const image4k = image.clone().resize(fourK.width, fourK.height, options);

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
