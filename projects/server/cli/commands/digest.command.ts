/** biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: generators are long and better that way. */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import firaCodeSrc from '@fontsource/ibm-plex-mono';
import overpassSrc from '@fontsource-variable/overpass';
import { Inject, type Provider } from '@nestjs/common';
import Bun from 'bun';
import chalk from 'chalk';
import { commaLists, oneLine, stripIndent } from 'common-tags';
import * as dateFns from 'date-fns';
import { Command, CommandRunner, Option } from 'nest-commander';
import open from 'open';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import logoSkyscraperSrc from '../../../shared/assets/logo-skyscraper.svg';
import loveChirperSrc from '../../../shared/assets/love-chirper.png';
import { iconsole } from '../../../shared/iconsole';
import { nn } from '../../../shared/utils/type-assertion';
import { config } from '../../config';
import { PrismaService, ScreenshotStorageService } from '../../services';

type SectionFunction = (options: SectionFunctionOptions) => SectionFunctionGenerator;

type SectionFunctionOptions = Readonly<{
  startDate: Date;
  endDate: Date;
  getBrowserPage: () => Promise<Page>;
  debug: boolean;
}>;

type SectionFunctionGenerator = AsyncIterableIterator<string, void, undefined>;

@Command({
  name: 'digest',
  arguments: '<month/year> [generators...]',
  description: `Generates Hall of Fame Digest for a given month.`
})
export class DigestCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [DigestCommand];

  @Option({
    flags: '--debug-puppeteer [boolean]',
    description: `Launch Puppeteer in headful mode and doesn't close the browser and pages automatically.`,
    required: false
  })
  public parseDebugPuppeteer(val: string): boolean {
    return val == 'true';
  }

  @Option({
    flags: '--open [boolean]',
    description: `Opens the output folder when the generation is complete, using the default app.`,
    required: false
  })
  public parseOpen(val: string): boolean {
    return val == 'true';
  }

  private static configuration = {
    topSize: 20,
    // Discord has a 10-images limit per message.
    // We will therefore limit ourselves to top-10s for images.
    topSizeForImages: 10,
    // Threshold for considering images in a top-X. Useful to limit noise: for example, an image
    // with 2 views and 1 like has 50% like/view ratio, but it's not significant.
    likesThreshold: 20
  };

  private static readonly outputPath = path.join(import.meta.dir, '../../../../.output/digest');

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(ScreenshotStorageService)
  private readonly screenshotStorage!: ScreenshotStorageService;

  private readonly generators: readonly SectionFunction[] = [
    this.redditExplainer,
    this.thumbnail,
    this.newMostAppreciatedPictures,
    this.overallMostAppreciatedPictures,
    this.topCreators,
    this.topCities
  ];

  public override async run(
    [dateStr, ...generatorNames]: [string, ...string[]],
    options: Readonly<{ debugPuppeteer: boolean; open: boolean }>
  ): Promise<void> {
    const startDate = dateFns.parse(dateStr, 'M/yy', new Date());

    const endDate = dateFns.endOfMonth(startDate);

    if (Number.isNaN(startDate.valueOf())) {
      throw `Invalid date: ${dateStr}, expected format: MM/YY.`;
    }

    const generators =
      generatorNames.length == 0
        ? this.generators
        : generatorNames.map(name => {
            const generator = this.generators.find(g => g.name == name);
            if (!generator) {
              throw commaLists`Unknown generator: ${name}, available generators: ${this.generators.map(g => g.name)}`;
            }

            return generator;
          });

    iconsole.log(
      chalk.bold.underline(`\n🏆 Hall of Fame Digest — ${dateFns.format(startDate, 'MMMM yyyy')}`)
    );

    await fs.rm(DigestCommand.outputPath, { recursive: true, force: true });

    let browser: Browser | undefined;

    try {
      for (const generator of generators) {
        iconsole.log(chalk.bold(`\n${'='.repeat(30)}\n`));

        const pages: Page[] = [];

        const getBrowserPage = async () => {
          browser ??= await puppeteer.launch({
            // This will both launch in headful mode and enable devtools.
            devtools: options.debugPuppeteer,
            // Mostly so that Chromium can store cache, but it will also remember devtools
            // preferences etc., which is nice.
            userDataDir: path.join(os.tmpdir(), 'halloffame/digest/chromium-user-data'),
            args: [
              // Not needed and makes installation more complex
              '--no-sandbox',
              // Needed for image caching to work when we setContent() on a about:blank page.
              '--disable-features=SplitCacheByNetworkIsolationKey'
            ]
          });

          const page = await browser.newPage();

          pages.push(page);

          return page;
        };

        try {
          const generatorOptions = {
            startDate,
            endDate,
            getBrowserPage,
            debug: options.debugPuppeteer
          };

          for await (const text of generator.call(this, generatorOptions)) {
            iconsole.log(text);
          }
        } finally {
          if (!options.debugPuppeteer) {
            await Promise.allSettled(pages.map(page => page.close()));
          }
        }
      }
    } finally {
      if (!options.debugPuppeteer) {
        await browser?.close();
      }
    }

    if (options.open) {
      await open(DigestCommand.outputPath, { wait: false });
    }
  }

  // biome-ignore lint/suspicious/useAwait: todo
  private async *thumbnail(_options: SectionFunctionOptions): SectionFunctionGenerator {
    yield '// todo';
  }

  // biome-ignore lint/suspicious/useAwait: no need, but contract.
  private async *redditExplainer(): SectionFunctionGenerator {
    yield para(
      oneLine`
      Hall of Fame is a Cities: Skylines II mod
      ([Paradox Mods](https://mods.paradoxplaza.com/mods/90641/Windows)) that allows you to upload
      4K screenshots right from within the game and then displays them for all people to see as main
      menu backgrounds… or here!`
    );

    yield para(
      oneLine`
      Each month, we will do a small digest of some of the screenshots, creators and cities that the
      community liked the most.`
    );

    yield para(`**Join the Hall of Fame community by downloading the mod and start uploading!**`);

    yield para(
      oneLine`
      ^(Join us on Discord:
      [Cities: Skylines Modding › pdxm-mods-published › Hall of Fame](https://discord.gg/tFE2kKHbFz))`
    );

    yield oneLine`
      _^(You already made lots of screenshots but not on Hall of Fame?
      Contact me to get them imported!)_`;
  }

  private async *newMostAppreciatedPictures(
    options: SectionFunctionOptions
  ): SectionFunctionGenerator {
    yield title(`❤️ New Most Appreciated Pictures`);

    yield para(
      oneLine`
      Images posted ≤ 2 months ago with at least ${DigestCommand.configuration.likesThreshold}
      likes, that have the highest ratio of likes to views (ex. 5 likes, 10 views = 50%).`
    );

    const startDate = dateFns.subMonths(options.startDate, 1);

    const pipeline = [
      {
        $match: {
          createdAt: { $gte: { $date: startDate }, $lte: { $date: options.endDate } },
          favoritesCount: { $gte: 20 }
        }
      },
      {
        $lookup: {
          from: 'views',
          let: { id: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$screenshotId', '$$id'] },
                    { $gte: ['$viewedAt', { $date: startDate }] },
                    { $lte: ['$viewedAt', { $date: options.endDate }] }
                  ]
                }
              }
            },
            {
              $group: { _id: '$creatorId' }
            },
            {
              $count: 'v'
            }
          ],
          as: '_viewsData'
        }
      },
      {
        $lookup: {
          from: 'favorites',
          let: { id: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$screenshotId', '$$id'] },
                    { $gte: ['$favoritedAt', { $date: startDate }] },
                    { $lte: ['$favoritedAt', { $date: options.endDate }] }
                  ]
                }
              }
            },
            {
              $count: 'f'
            }
          ],
          as: '_favoritesData'
        }
      },
      {
        $addFields: {
          _viewsCount: {
            $ifNull: [{ $arrayElemAt: ['$_viewsData.v', 0] }, 0]
          },
          _favoritesCount: {
            $ifNull: [{ $arrayElemAt: ['$_favoritesData.f', 0] }, 0]
          }
        }
      },
      {
        $match: {
          $expr: { $gte: ['$_favoritesCount', DigestCommand.configuration.likesThreshold] }
        }
      },
      {
        $addFields: {
          _favoritingPercentage: {
            $cond: [
              { $gt: ['$_viewsCount', 0] },
              { $multiply: [{ $divide: ['$_favoritesCount', '$_viewsCount'] }, 100] },
              0
            ]
          }
        }
      },
      {
        $lookup: {
          from: 'creators',
          localField: 'creatorId',
          foreignField: '_id',
          as: '_creator'
        }
      },
      {
        $unwind: '$_creator'
      },
      {
        $sort: { _favoritingPercentage: -1 }
      },
      {
        $limit: DigestCommand.configuration.topSize
      },
      {
        $project: {
          _id: 0,
          screenshot: '$$ROOT',
          creator: '$_creator',
          favoritesCount: '$_favoritesCount',
          favoritingPercentage: '$_favoritingPercentage'
        }
      }
    ];

    const rawResults = (await this.prisma.screenshot.aggregateRaw({
      pipeline
    })) as unknown as readonly Readonly<{
      favoritesCount: number;
      favoritingPercentage: number;
      screenshot: Readonly<{
        _id: Readonly<{ $oid: string }>;
        cityName: string;
        cityNameTranslated: string;
        imageUrl4K: string;
      }>;
      creator: Readonly<{
        creatorName: string;
        creatorNameTranslated: string;
      }>;
    }>[];

    const results = rawResults.map(({ creator, screenshot, ...rest }) => ({
      ...rest,
      creator,
      screenshot,
      cityName: screenshot.cityNameTranslated ?? screenshot.cityName,
      creatorName: creator.creatorNameTranslated ?? creator.creatorName ?? 'Anonymous',
      favoritingPercentage: Math.round(rest.favoritingPercentage)
    }));

    for (let index = 0; index < results.length; index++) {
      const { screenshot, cityName, creatorName, favoritesCount, favoritingPercentage } = nn(
        results[index]
      );

      const imageUrl = `${config.http.baseUrl}/api/v1/screenshots/${screenshot._id.$oid}/4k.jpg`;

      yield oneLine`
        ${index + 1}. **[${cityName}](${imageUrl})** by **${creatorName}** —
        ${favoritesCount} ❤️ ${favoritingPercentage}%`;
    }

    yield '';

    for (let index = 0; index < DigestCommand.configuration.topSizeForImages; index++) {
      const { screenshot, cityName, creatorName, favoritesCount, favoritingPercentage } = nn(
        results[index]
      );

      const startDateMonthStr = dateFns.format(startDate, 'MMMM').toLowerCase();
      const endDateMonthStr = dateFns.format(options.endDate, 'MMMM').toLowerCase();

      yield this.renderSinglePictureTemplate(options, {
        generatorName: this.newMostAppreciatedPictures.name,
        legend: oneLine`
          best like/view ratio,
          ${startDateMonthStr}/${endDateMonthStr} posts,
          ≥ ${DigestCommand.configuration.likesThreshold} likes`,
        position: index + 1,
        imageUrl: this.screenshotStorage.getScreenshotUrl(screenshot.imageUrl4K),
        cityName,
        creatorName,
        likesText: `${favoritingPercentage}% liking ratio, ${favoritesCount} likes`
      });
    }
  }

  // biome-ignore lint/suspicious/useAwait: todo
  private async *overallMostAppreciatedPictures(
    _options: SectionFunctionOptions
  ): SectionFunctionGenerator {
    yield '// todo';
  }

  // biome-ignore lint/suspicious/useAwait: todo
  private async *topCreators(_options: SectionFunctionOptions): SectionFunctionGenerator {
    yield '// todo';
  }

  // biome-ignore lint/suspicious/useAwait: todo
  private async *topCities(_options: SectionFunctionOptions): SectionFunctionGenerator {
    yield '// todo';
  }

  private async renderSinglePictureTemplate(
    generatorOptions: SectionFunctionOptions,
    options: Readonly<{
      generatorName: string;
      legend: string;
      position: number;
      imageUrl: string;
      cityName: string;
      creatorName: string;
      likesText: string;
    }>
  ): Promise<string> {
    // noinspection HtmlRequiredAltAttribute,AngularNgOptimizedImage,CssUnknownTarget,CssNoGenericFontName
    const html = stripIndent`
    <!doctype html>
    <style>
    @import url("file://${firaCodeSrc}");
    @import url("file://${overpassSrc}");

    body {
      margin: 0;
      line-height: .9;
      font-family: "Overpass Variable";
      font-size: 1.5vw;
      font-weight: 600;
      color: white;
    }

    main > img {
      width: 100%;
    }

    main > .layout {
      position: absolute;
      inset: 0;

      display: grid;
      grid-template: 1fr 1fr / 1fr auto;

      padding: 8rem;

      > :nth-child(1) { place-self: start start; } /* ⬑ top-left   */
      > :nth-child(2) { place-self: start end;   } /* ⬏ top-right  */
      > :nth-child(3) { place-self: end   start; } /* ⬐ bottom-left*/
      > :nth-child(4) { place-self: end   end;   } /* ⬎ bottom-right*/

      > .layout_header {
        display: flex;
        font-size: 1.75em;
        filter: drop-shadow(0 0 .3rem rgb(0 0 0 / 60%));

        > .layout_header_position {
          margin-right: .5ch;
        }

        &.layout_header-medal {
          align-items: center;

          > .layout_header_position {
            font-size: 1.1em;
          }
        }

        &.layout_header-no-medal {
          > .layout_header_position {
            line-height: .75; /* visual fix for alignment with title */
            font-family: "IBM Plex Mono";
            font-size: .9em;
            opacity: .8;
          }
        }

        > h1 {
          margin: 0;
          font-size: inherit;

          > small {
            font-size: .6em;
            font-weight: inherit;
          }
        }
      }

      > .layout_likes {
        display: flex;
        gap: .5em;
        align-items: center;
        filter: drop-shadow(0 0 .3rem rgb(0 0 0 / 60%));

        > img {
          height: 1.5em;
        }
      }

      > .layout_legend {
        font-family: "IBM Plex Mono";
        font-size: .6em;
        filter: drop-shadow(.1rem .1rem .1rem rgb(0 0 0 / 60%));
      }

      > .layout_hof {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;

        > img {
          width: 12rem;
          height: 12rem;
          margin-bottom: 1rem;
        }

        > .layout_hof_name, > .layout_hof_date {
          filter: drop-shadow(.1rem .1rem .1rem rgb(0 0 0 / 60%));
        }

        > .layout_hof_name {
          text-transform: uppercase;
          font-weight: 100;
        }

        > .layout_hof_date {
        }
      }
    }
    </style>

    <main>
      <img src="${options.imageUrl}">

      <section class="layout">
        <header class="layout_header layout_header-${options.position <= 3 ? 'medal' : 'no-medal'}">
          <span class="layout_header_position">
            ${
              options.position <= 3
                ? getMedalForPosition(options.position)
                : `<small>#</small>${options.position}`
            }
          </span>

          <h1>
            ${options.cityName}<br>
            <small>by ${options.creatorName}</small>
          </h1>
        </header>

        <div class="layout_legend">
          ${options.legend}
        </div>

        <div class="layout_likes">
          <img src="file://${loveChirperSrc}">
          ${options.likesText}
        </div>

        <div class="layout_hof">
          <img src="file://${logoSkyscraperSrc}">
          <span class="layout_hof_name">Hall of Fame</span>
          <span class="layout_hof_date">
            ${dateFns.format(generatorOptions.startDate, `MMMM ’yy`)}
          </span>
        </div>
      </section>
    </main>`;

    const htmlPath = path.join(os.tmpdir(), 'halloffame/digest/index.html');

    await Bun.write(htmlPath, html);

    const page = await generatorOptions.getBrowserPage();

    // If headful and devtools are enabled, wait a bit for the devtools to open, or we will miss
    // all or some network requests.
    if (generatorOptions.debug) {
      await setTimeout(500);
    }

    await page.goto(`file://${htmlPath}`);

    const { width, height } = await page.$eval('img', imgEl => ({
      width: imgEl.naturalWidth,
      height: imgEl.naturalHeight
    }));

    await page.setViewport({ width, height });

    const clipEl = await page.$('img');
    nn.assert(clipEl);

    const filePath = path.join(
      DigestCommand.outputPath,
      options.generatorName,
      `${options.position} - ${options.cityName} by ${options.creatorName}.webp`
    );

    const buffer = await clipEl.screenshot({ type: 'webp' });

    // The viewport we set earlier is larger than most screens, so it's impractical for debugging,
    // so we reset it to null in debug (use native screen size).
    if (generatorOptions.debug) {
      await page.setViewport(null);
    }

    await Bun.write(filePath, buffer);

    return filePath;
  }
}

function title(text: string): string {
  return chalk.bold(`# ${text}\n`);
}

function para(text: string): string {
  return `${text}\n`;
}

function getMedalForPosition(position: number): string {
  switch (position) {
    case 1:
      return '🥇';
    case 2:
      return '🥈';
    case 3:
      return '🥉';
    default:
      throw new Error(`No medal for position #${position}`);
  }
}
