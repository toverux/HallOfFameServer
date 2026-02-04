import { Inject, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { stripIndent } from 'common-tags';
import { CommandRunner, SubCommand } from 'nest-commander';
import puppeteer, { type Page, PuppeteerError } from 'puppeteer';
import type { Creator, Mod, Screenshot } from '#prisma-lib/client';
import { iconsole } from '../../../../shared/iconsole';
import type { ParadoxModId } from '../../../../shared/utils/branded-types';
import { nn } from '../../../../shared/utils/type-assertion';
import { config } from '../../../config';
import { ModService, PrismaService, ScreenshotStorageService } from '../../../services';

type ModeratedScreenshot = Screenshot & { imageUrl: string; creator: Creator; showcasedMod: Mod };

interface HofWindow extends Window {
  setStatus: (text: string) => void;
  showcasedModerationEvent: PromiseWithResolvers<'accept' | 'remove'>;
  setScreenshotData: (data: ModeratedScreenshot) => void;
}

@SubCommand({
  name: 'showcased-mods',
  description: `Review screenshots that showcase a mod to accept or remove the showcase.`
})
export class ModerateShowcasedModsCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [ModerateShowcasedModsCommand];

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(ModService)
  private readonly modService!: ModService;

  @Inject(ScreenshotStorageService)
  private readonly screenshotStorage!: ScreenshotStorageService;

  public override async run(_args: never): Promise<void> {
    iconsole.log('Finding screenshots to moderate...');

    const screenshots = await this.prisma.screenshot.findMany({
      where: { showcasedModId: { not: null }, isShowcasedModValidated: false },
      include: { creator: true }
    });

    iconsole.log(chalk.bold(`Found ${screenshots.length} screenshots to moderate.`));

    if (!screenshots.length) {
      return;
    }

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
      await this.loopOverScreenshots(page, screenshots);
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

  private async loopOverScreenshots(
    page: Page,
    screenshots: ReadonlyArray<Screenshot & { readonly creator: Creator }>
  ): Promise<void> {
    function setPageStatus(text: string): void {
      page.evaluate(text => (window as unknown as HofWindow).setStatus(text), text);
    }

    for (const screenshot of screenshots) {
      const showcasedMod = await this.modService.getMod(screenshot.showcasedModId as ParadoxModId);

      if (!showcasedMod) {
        iconsole.error(
          chalk.bold.redBright(
            `Screenshot #${screenshot.id} has a showcased mod that does not exist.`
          )
        );

        continue;
      }

      await page.evaluate(data => (window as unknown as HofWindow).setScreenshotData(data), {
        ...screenshot,
        imageUrl: this.screenshotStorage.getScreenshotUrl(screenshot.imageUrlFHD),
        showcasedMod
      } satisfies ModeratedScreenshot);

      setPageStatus(`Ready.`);

      const action = await page.evaluate(
        () => (window as unknown as HofWindow).showcasedModerationEvent.promise
      );

      setPageStatus(`Loading next...`);

      if (action == 'accept') {
        await this.prisma.screenshot.update({
          where: { id: screenshot.id },
          data: { isShowcasedModValidated: true }
        });

        iconsole.log(`Accepted showcase for screenshot #${screenshot.id}.`);
      } else if (action == 'remove') {
        await this.prisma.screenshot.update({
          where: { id: screenshot.id },
          data: { showcasedModId: null, isShowcasedModValidated: false }
        });

        iconsole.log(`Removed showcase for screenshot #${screenshot.id}.`);
      }
    }

    iconsole.info(chalk.bold(`All screenshots have been moderated.`));
  }

  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: it is normal
  private getPageHtml() {
    // noinspection HtmlRequiredAltAttribute,RequiredAttributes
    return stripIndent`
    <title>HoF Showcased Mods Moderation</title>
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

      .info {
        position: absolute;
        inset: 16px 16px auto auto;
        width: 20%;
        display: flex;
        flex-direction: column;
        gap: 8px;

        > .info--screenshot-info {
          font-size: 1.2rem;
        }

        > .info--mod-thumbnail {
          aspect-ratio: 1;
          object-fit: contain;
        }

        > .info--mod-name {
          font-size: 1.5rem;
          color: inherit;
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

    <div id="status" class="block">Waiting for backend...</div>

    <div class="block info">
      <span class="info--screenshot-info"></span>
      <small class="info--screenshot-description"></small>
      <img class="info--mod-thumbnail" />
      <a class="info--mod-name"></a>
      <span class="info--mod-description"></span>

      <div class="info--buttons">
        <button id="accept">Accept</button>
        <button id="remove">Remove</button>
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
      const infoEl = document.querySelector('.info') as HTMLElement;
      const screenshotInfoEl = document.querySelector('.info .info--screenshot-info')!;
      const screenshotDescriptionEl = document.querySelector(
        '.info .info--screenshot-description'
      )!;
      const modThumbnailEl = document.querySelector(
        '.info .info--mod-thumbnail'
      ) as HTMLImageElement;
      const modNameEl = document.querySelector('.info .info--mod-name') as HTMLAnchorElement;
      const modDescriptionEl = document.querySelector('.info .info--mod-description')!;
      const acceptButtonEl = document.querySelector('.info #accept')!;
      const removeButtonEl = document.querySelector('.info #remove')!;
      // biome-ignore-end lint/style/noNonNullAssertion: they are defined

      let screenshot: ModeratedScreenshot | undefined;

      const hofWindow = window as unknown as HofWindow;

      hofWindow.setStatus = setStatus;
      hofWindow.setScreenshotData = setScreenshotData;

      imgEl.addEventListener('load', () => {
        imgEl.style.visibility = 'visible';
      });

      const resolve = (result: 'accept' | 'remove') => {
        hofWindow.showcasedModerationEvent.resolve(result);
        screenshot = undefined;
        refreshScreenshot();
      };

      acceptButtonEl.addEventListener('click', () => resolve('accept'));
      removeButtonEl.addEventListener('click', () => resolve('remove'));

      refreshScreenshot();

      return;

      function setStatus(text: string): void {
        statusEl.textContent = text;
      }

      function setScreenshotData(newScreenshot: ModeratedScreenshot): void {
        screenshot = newScreenshot;
        hofWindow.showcasedModerationEvent = Promise.withResolvers();

        refreshScreenshot();
      }

      function refreshScreenshot(): void {
        infoEl.style.visibility = screenshot ? 'visible' : 'hidden';

        if (!screenshot) {
          return;
        }

        // Very important, we don't want to show the previous image while the new one is loading.
        // The onload handler will restore visibility once the image is loaded.
        imgEl.style.visibility = 'hidden';

        imgEl.src = screenshot.imageUrl;

        const cityName = screenshot.cityNameTranslated ?? screenshot.cityName;
        const authorName =
          screenshot.creator.creatorNameTranslated ?? screenshot.creator.creatorName;

        screenshotInfoEl.textContent = `${cityName} by ${authorName}`;
        screenshotDescriptionEl.textContent = screenshot.description;

        modThumbnailEl.src = screenshot.showcasedMod.thumbnailUrl;
        modNameEl.href = `https://mods.paradoxplaza.com/mods/${screenshot.showcasedMod.paradoxModId}/Windows`;
        modNameEl.textContent = screenshot.showcasedMod.name;
        modDescriptionEl.textContent = screenshot.showcasedMod.shortDescription;
      }
    }
  }
}
