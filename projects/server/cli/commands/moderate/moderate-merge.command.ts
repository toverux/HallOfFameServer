import { Inject, type Provider } from '@nestjs/common';
import { oneLine, stripIndent } from 'common-tags';
import { CommandRunner, SubCommand } from 'nest-commander';
import puppeteer, { type Page, PuppeteerError } from 'puppeteer';
import type { Creator, Screenshot } from '#prisma-lib/client';
import { iconsole } from '../../../../shared/iconsole';
import { nn } from '../../../../shared/utils/type-assertion';
import { config } from '../../../config';
import {
  PrismaService,
  ScreenshotMergingService,
  ScreenshotSimilarityDetectorService,
  ScreenshotStorageService
} from '../../../services';

interface ScreenshotsData {
  firstScreenshot: Screenshot & { imageUrl: string; creator: Creator };
  secondScreenshot: Screenshot & { imageUrl: string; creator: Creator };
  distance: number;
}

interface HofWindow extends Window {
  setStatus: (text: string) => void;
  screenshotSelectedEvent: PromiseWithResolvers<'first' | 'both' | 'second'>;
  setScreenshotsData: (data: ScreenshotsData) => void;
}

@SubCommand({
  name: 'merge',
  description: `Find screenshots that are semantically close to each other and merge or whitelist them.`
})
export class ModerateMergeCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [ModerateMergeCommand];

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(ScreenshotMergingService)
  private readonly screenshotMerging!: ScreenshotMergingService;

  @Inject(ScreenshotSimilarityDetectorService)
  private readonly screenshotSimilarityDetector!: ScreenshotSimilarityDetectorService;

  @Inject(ScreenshotStorageService)
  private readonly screenshotStorage!: ScreenshotStorageService;

  public override async run(_args: never): Promise<void> {
    const browser = await puppeteer.launch({
      headless: false,
      userDataDir: config.puppeteer.userDataDir,
      args: [...config.puppeteer.args, '--start-fullscreen'],
      protocolTimeout: 3_600_000
    });

    // Get default page.
    const [page] = await browser.pages();
    nn.assert(page);

    // Setting a null viewport makes the page the size of the browser window.
    await page.setViewport(null);

    await page.setContent(this.getPageHtml());

    try {
      await this.loopOverScreenshots(page);
    } catch (error) {
      // In all cases we don't want to miss errors: quit the browser so that the moderator will see
      // the error.
      if (browser.connected) {
        await browser.close();
      }

      // This should just be because the browser was gracefully closed and the user want to stop.
      if (
        !config.verbose &&
        (error instanceof PuppeteerError ||
          (error instanceof Error && error.message.includes('Execution context was destroyed')))
      ) {
        iconsole.log(`Puppeteer: ${error.message} (Run with --verbose to rethrow.)`);
        return;
      }

      throw error;
    }

    await browser.close();
  }

  private async loopOverScreenshots(page: Page): Promise<void> {
    function setPageStatus(text: string): void {
      page.evaluate(text => (window as unknown as HofWindow).setStatus(text), text);
    }

    let lastChoice: 'first' | 'second' | 'both' | undefined;

    for await (const {
      screenshots: [first, second],
      distance
    } of this.screenshotSimilarityDetector.findPotentialDuplicates()) {
      iconsole.log(`Matching screenshots: #${first.id} and #${second.id}...`);

      const authors = await this.prisma.creator.findMany({
        where: { id: { in: [first.creatorId, second.creatorId] } }
      });

      const firstCreator = nn(authors.find(author => author.id == first.creatorId));
      const secondCreator = nn(authors.find(author => author.id == second.creatorId));

      await page.evaluate(data => (window as unknown as HofWindow).setScreenshotsData(data), {
        distance,
        firstScreenshot: {
          ...first,
          imageUrl: this.screenshotStorage.getScreenshotUrl(first.imageUrl4K),
          creator: firstCreator
        },
        secondScreenshot: {
          ...second,
          imageUrl: this.screenshotStorage.getScreenshotUrl(second.imageUrl4K),
          creator: secondCreator
        }
      } satisfies ScreenshotsData);

      // noinspection JSUnusedAssignment
      if (!lastChoice || lastChoice == 'both') {
        setPageStatus(`Ready.`);
      }

      lastChoice = await page.evaluate(
        () => (window as unknown as HofWindow).screenshotSelectedEvent.promise
      );

      if (lastChoice == 'both') {
        setPageStatus(`Loading next...`);

        await this.screenshotSimilarityDetector.allowScreenshotSimilarity(first.id, second.id);

        continue;
      }

      setPageStatus(`Merging screenshots...`);

      const { mergedFavoritesCount, deletedFavoritesCount, mergedViewsCount, deletedViewsCount } =
        await this.screenshotMerging.mergeScreenshots(
          lastChoice == 'first' ? first.id : second.id,
          [lastChoice == 'first' ? second.id : first.id]
        );

      setPageStatus(
        oneLine`
        Merged
        ${mergedFavoritesCount} favorites (${deletedFavoritesCount} duplicates deleted),
        ${mergedViewsCount} views (${deletedViewsCount} duplicates deleted).`
      );
    }
  }

  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: it is normal
  private getPageHtml() {
    // noinspection HtmlRequiredAltAttribute,RequiredAttributes
    return stripIndent`
    <title>HoF Similar Screenshots Moderation</title>
    <style>
      :root { font-family: sans-serif; }
      *, *:before, *:after { box-sizing: border-box; }
      * { margin: 0; padding: 0; }

      body {
        width: 100vw;
        height: 100vh;
        background-color: black;
      }

      img#screenshot {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

      .block {
        border-radius: 16px;
        padding: 16px;
        background-color: rgba(0, 0, 0, 0.5);
        color: white;
      }

      #letter {
        position: absolute;
        inset: 16px auto auto 16px;
        font-size: 3rem;
      }

      .info {
        position: absolute;
        inset: 16px 16px auto auto;
        width: 20%;
        display: flex;
        flex-direction: column;
        gap: 8px;

        > #cityName {
          font-size: 2rem;
        }

        > .info--buttons {
          display: flex;
          justify-content: space-evenly;
          gap: 8px;

          > button {
            margin-top: 16px;
            font-size: 1.2rem;
            padding: 8px;
          }
        }
      }

      #status {
        position: absolute;
        inset: auto 16px 16px 16px;
        text-align: center;
      }
    </style>

    <img id="screenshot" />

    <div id="letter" class="block">#</div>

    <div id="status" class="block">Waiting for backend...</div>

    <div class="block info">
      <span id="cityName"></span>
      <span id="authorName"></span>
      <span id="similarity"></span>
      <span id="date"></span>
      <span id="favorites"></span>

      <div class="info--buttons">
        <button id="keep-first">Keep A</button>
        <button id="keep-both">Keep Both</button>
        <button id="keep-second">Keep B</button>
      </div>
    </div>

    <script type="module">
      ${script.toString()}
      script();
    </script>
    `;

    /**
     * This is serialized to a string and injected into the page, so do not use any external symbol,
     * this must be fully standalone.
     */
    // biome-ignore lint/complexity/noExcessiveLinesPerFunction: it is normal
    function script() {
      // biome-ignore-start lint/style/noNonNullAssertion: they are defined
      const imgEl = document.getElementById('screenshot') as HTMLImageElement;
      const statusEl = document.getElementById('status')!;
      const letterEl = document.getElementById('letter')!;
      const infoEl = document.querySelector('.info') as HTMLElement;
      const cityNameEl = document.querySelector('.info #cityName')!;
      const authorNameEl = document.querySelector('.info #authorName')!;
      const similarityEl = document.querySelector('.info #similarity')!;
      const dateEl = document.querySelector('.info #date')!;
      const favoritesEl = document.querySelector('.info #favorites')!;
      const keepFirstButton = document.getElementById('keep-first')!;
      const keepBothButton = document.getElementById('keep-both')!;
      const keepSecondButton = document.getElementById('keep-second')!;
      // biome-ignore-end lint/style/noNonNullAssertion: they are defined

      let data: ScreenshotsData | undefined;

      let curScreenshot: ScreenshotsData['firstScreenshot'] | ScreenshotsData['secondScreenshot'];

      const hofWindow = window as unknown as HofWindow;

      hofWindow.setStatus = setStatus;
      hofWindow.setScreenshotsData = setScreenshotsData;

      imgEl.addEventListener('load', () => {
        imgEl.style.visibility = 'visible';
      });

      imgEl.addEventListener('click', () => {
        if (data) {
          curScreenshot =
            curScreenshot == data.firstScreenshot ? data.secondScreenshot : data.firstScreenshot;

          refreshCurrentScreenshot();
        }
      });

      const resolve = (result: 'first' | 'both' | 'second') => {
        hofWindow.screenshotSelectedEvent.resolve(result);
        data = undefined;
        refreshCurrentScreenshot();
      };

      keepFirstButton.addEventListener('click', () => resolve('first'));
      keepBothButton.addEventListener('click', () => resolve('both'));
      keepSecondButton.addEventListener('click', () => resolve('second'));

      refreshCurrentScreenshot();

      return;

      function setStatus(text: string): void {
        statusEl.textContent = text;
      }

      function setScreenshotsData(newData: ScreenshotsData): void {
        data = newData;
        curScreenshot = data.firstScreenshot;
        hofWindow.screenshotSelectedEvent = Promise.withResolvers();

        refreshCurrentScreenshot();
      }

      function refreshCurrentScreenshot(): void {
        letterEl.style.visibility = data ? 'visible' : 'hidden';
        infoEl.style.visibility = data ? 'visible' : 'hidden';

        if (!data) {
          return;
        }

        // Very important, we don't want to show the previous image while the new one is loading.
        // The onload handler will restore visibility once the image is loaded.
        imgEl.style.visibility = 'hidden';

        imgEl.src = curScreenshot.imageUrl;

        letterEl.textContent = curScreenshot == data.firstScreenshot ? 'A' : 'B';

        cityNameEl.textContent = curScreenshot.cityNameTranslated ?? curScreenshot.cityName;

        authorNameEl.textContent =
          curScreenshot.creator.creatorNameTranslated ?? curScreenshot.creator.creatorName;

        similarityEl.textContent = `${Math.round(100 * (1 - data.distance))}%`;

        dateEl.textContent = new Date(curScreenshot.createdAt).toLocaleString();

        favoritesEl.textContent = `${curScreenshot.favoritesCount} favorites, ${curScreenshot.favoritingPercentage}%`;
      }
    }
  }
}
