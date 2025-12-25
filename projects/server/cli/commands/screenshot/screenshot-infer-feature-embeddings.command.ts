import * as os from 'node:os';
import { Inject, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { oneLine } from 'common-tags';
import { filesize } from 'filesize';
import { CommandRunner, Option, SubCommand } from 'nest-commander';
import { bufferCount, from, lastValueFrom, mergeMap, retry } from 'rxjs';
import { iconsole } from '../../../../shared/iconsole';
import { PrismaService, ScreenshotSimilarityDetectorService } from '../../../services';

@SubCommand({
  name: 'infer-feature-embeddings',
  arguments: '[...ids]',
  description: oneLine`
    Generates feature vector embeddings for screenshots.
    If IDs are provided, only those screenshots will be processed.`
})
export class ScreenshotInferFeatureEmbeddingsCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [
    ScreenshotInferFeatureEmbeddingsCommand
  ];

  @Inject(ScreenshotSimilarityDetectorService)
  private readonly imageSimilarityDetector!: ScreenshotSimilarityDetectorService;

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Option({
    flags: '--only-missing [boolean]',
    description: `Run inference only on screenshots that have no embedding.`,
    required: true
  })
  public parseBoolean(val: string): boolean {
    return val == 'true';
  }

  @Option({
    flags: '-s, --batch-size [number]',
    description: `How much images should the inference be run on at the same time.`,
    defaultValue: 100
  })
  public parseBatchSize(val: string): number {
    const batchSize = Number.parseInt(val, 10);

    if (batchSize < 1 || Number.isNaN(batchSize)) {
      throw `Batch size must not be inferior to 1, got ${batchSize}.`;
    }

    return batchSize;
  }

  @Option({
    flags: '-c, --concurrency [number]',
    description: oneLine`
      How many BATCHES of images should be downloaded in parallel (inference is always run for one
      batch at a time only).`,
    defaultValue: 2
  })
  public parseConcurrency(val: string): number {
    const concurrency = Number.parseInt(val, 10);

    if (concurrency < 1 || Number.isNaN(concurrency)) {
      throw `Concurrency must not be inferior to 1, got ${concurrency}.`;
    }

    return concurrency;
  }

  @Option({
    flags: '-r, --retries [number]',
    description: `How many times should a batch of images be retried if it fails.`,
    defaultValue: 4
  })
  public parseRetries(val: string): number {
    const retries = Number.parseInt(val, 10);

    if (retries < 0 || Number.isNaN(retries)) {
      throw `Retries count must not be inferior to 0, got ${retries}.`;
    }

    return retries;
  }

  public override async run(
    screenshotIds: string[],
    options: {
      readonly onlyMissing: boolean;
      readonly batchSize: number;
      readonly concurrency: number;
      readonly retries: number;
    }
  ): Promise<void> {
    // Get screenshots to process.
    const screenshots = await this.prisma.screenshot.findMany({
      where: {
        ...(options.onlyMissing ? { similarityEmbedding: null } : {}),
        ...(screenshotIds.length > 0 ? { id: { in: screenshotIds } } : {})
      },
      select: { id: true, cityName: true, imageUrlFHD: true }
    });

    if (screenshots.length == 0) {
      iconsole.info(chalk.bold(`No screenshots to process.`));
      return;
    }

    iconsole.info(chalk.bold(`Found ${screenshots.length} screenshots to process.`));

    let processedCount = 0;

    // Process screenshots in parallel using RxJS.
    const totalBatches = Math.ceil(screenshots.length / options.batchSize);

    await lastValueFrom(
      from(screenshots).pipe(
        bufferCount(options.batchSize),
        mergeMap(async (screenshotsBatch, index) => {
          iconsole.info(
            oneLine`
            ${chalk.bold.blueBright(`Starting batch ${index + 1} of ${totalBatches}`)}
            ${this.getFreeMemText()}`
          );

          await this.imageSimilarityDetector.batchUpdateEmbeddings(
            (index + 1).toString(),
            screenshotsBatch.map(screenshot => ({
              id: screenshot.id,
              imageUrlOrBuffer: screenshot.imageUrlFHD
            }))
          );

          processedCount += screenshotsBatch.length;

          iconsole.info(
            oneLine`
            ${chalk.bold.greenBright(`Batch ${index + 1} of ${totalBatches} successful`)}
            (${processedCount}/${screenshots.length})
            ${this.getFreeMemText()}`
          );
        }, options.concurrency),
        retry(options.retries)
      )
    );

    iconsole.info(chalk.bold(`Done processing ${screenshots.length} screenshots.`));
  }

  private getFreeMemText(): string {
    const freeMem = filesize(os.freemem());

    return chalk.dim(`(free memory=${freeMem})`);
  }
}
