import * as path from 'node:path';
import process from 'node:process';
import { Inject, type Provider } from '@nestjs/common';
import Bun from 'bun';
import { oneLine } from 'common-tags';
import * as dateFns from 'date-fns';
import { Command, CommandRunner, InquirerService, Question, QuestionSet } from 'nest-commander';
import type { Creator, Screenshot } from '#prisma-lib/client';
import { iconsole } from '../../../shared/iconsole';
import { nn } from '../../../shared/utils';
import type { Maybe, ParadoxModId } from '../../common';
import { PrismaService, ScreenshotService } from '../../services';

// https://cs2.paradoxwikis.com/Progression#Milestones
const milestones = [
  'Tiny Village',
  'Small Village',
  'Large Village',
  'Grand Village',
  'Tiny Town',
  'Boom Town',
  'Busy Town',
  'Big Town',
  'Great Town',
  'Small City',
  'Big City',
  'Large City',
  'Huge City',
  'Grand City',
  'Metropolis',
  'Thriving Metropolis',
  'Flourishing Metropolis',
  'Expansive Metropolis',
  'Massive Metropolis',
  'Megalopolis'
];

@Command({
  name: 'import-city',
  description: oneLine`
    Interactive command to import screenshots images for a new or existing Creator from a
    directory.`,
  arguments: '<directoryPath>'
})
export class ImportCityCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [
    ImportCityCommand,
    CityInfoQuestions,
    ConfirmCityInfoQuestions,
    ConfirmUpdateQuestions
  ];

  @Inject(InquirerService)
  private readonly inquirer!: InquirerService;

  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Inject(ScreenshotService)
  private readonly screenshotService!: ScreenshotService;

  public override async run([directoryPath]: [string]): Promise<void> {
    // Find all PNG and JPG files in the directory passed as argument.
    const filePaths = this.getFilesList(directoryPath);

    let confirm = false;

    // Loop until the user confirms all the confirmation prompts.
    while (!confirm) {
      // Ask the user for the city information.
      const cityInfo = await this.askForCityInfo();

      confirm = cityInfo != null;
      if (!confirm) {
        continue;
      }

      nn.assert(cityInfo);

      // Check if the creator already exists.
      const creator = await this.prisma.creator.findFirst({
        where: { id: cityInfo.creatorId }
      });

      if (!creator) {
        iconsole.error(`Creator "${cityInfo.creatorId}" not found.`);
        continue;
      }

      // Check if the creator already has screenshots for a city that has the same name.
      // Helps to avoid accidental re-imports.
      const existingCity = await this.prisma.screenshot.findFirst({
        where: {
          creatorId: creator.id,
          cityName: {
            mode: 'insensitive',
            equals: cityInfo.cityName
          }
        }
      });

      // Ask the user to confirm the changes.
      confirm = await this.confirmChanges(existingCity, cityInfo, filePaths);

      if (!confirm) {
        continue;
      }

      // Make the creator a supporter if requested.
      await this.maybeMakeCreatorSupporter(creator, creator, cityInfo);

      // Import the screenshots.
      await this.ingestScreenshots(directoryPath, filePaths, creator, cityInfo);
    }
  }

  private getFilesList(directoryPath: string): readonly string[] {
    const glob = new Bun.Glob('**/*.{png,jpg}');
    const filePaths = Array.from(
      glob.scanSync({
        cwd: directoryPath,
        onlyFiles: true
      })
    );

    // If no files are found, log an error and exit.
    if (!filePaths.length) {
      iconsole.error(`No screenshots found in the directory.`);
      process.exit(1);
    }

    iconsole.info(`Found ${filePaths.length} candidate file(s) in directory.`);

    return filePaths;
  }

  private async askForCityInfo(): Promise<CityInfoQuestionsResult | undefined> {
    const cityInfo = await this.inquirer.ask<CityInfoQuestionsResult>('city-info', undefined);

    // Log the city information for the user to review.
    iconsole.info(`\nPlease review the city information:`, cityInfo);

    return await this.inquirer
      .ask<ConfirmCityInfoQuestionsResult>('confirm-city-info', undefined)
      .then(result => (result.confirm ? cityInfo : undefined));
  }

  private confirmChanges(
    existingCity: Maybe<Screenshot>,
    cityInfo: CityInfoQuestionsResult,
    filePaths: readonly string[]
  ): Promise<boolean> {
    iconsole.info(`\nPlease review this carefully:`);

    existingCity
      ? iconsole.info(` - Add to EXISTING City "${existingCity.cityName}" #${existingCity.id}.`)
      : iconsole.info(` - Create screenshot(s) for a NEW City "${cityInfo.cityName}".`);

    iconsole.info(
      ` - Create Screenshot record(s) for each of those ${filePaths.length} files:`,
      filePaths.join(', ')
    );

    return this.inquirer
      .ask<ConfirmUpdateQuestionsResult>('confirm-update', undefined)
      .then(result => result.confirm);
  }

  private async maybeMakeCreatorSupporter(
    creator: Creator,
    existingCreator: Maybe<Creator>,
    cityInfo: CityInfoQuestionsResult
  ): Promise<void> {
    if (cityInfo.makeCreatorSupporter && !existingCreator?.isSupporter) {
      await this.prisma.creator.update({
        where: { id: creator.id },
        data: { isSupporter: true }
      });

      iconsole.info(`Made Creator "${creator.creatorName ?? '<anonymous>'}" a supporter.`);
    }
  }

  private async ingestScreenshots(
    directoryPath: string,
    filePaths: readonly string[],
    creator: Creator,
    cityInfo: CityInfoQuestionsResult
  ): Promise<void> {
    // Loop over each file and import it.
    for (const filePath of filePaths) {
      const absoluteFilePath = path.join(directoryPath, filePath);

      const fileBytes = await Bun.file(absoluteFilePath).arrayBuffer();

      const screenshot = await this.screenshotService.ingestScreenshot({
        creator,
        cityName: cityInfo.cityName,
        cityMilestone: cityInfo.cityMilestone,
        cityPopulation: cityInfo.cityPopulation,
        showcasedModId: undefined,
        description: undefined,
        shareParadoxModIds: true,
        paradoxModIds: new Set<ParadoxModId>(),
        shareRenderSettings: true,
        renderSettings: {},
        metadata: {},
        createdAt: cityInfo.date,
        file: Buffer.from(fileBytes),
        healthcheck: false
      });

      iconsole.info(`Imported screenshot "${filePath}", #${screenshot.id}`);
    }
  }
}

interface CityInfoQuestionsResult {
  creatorId: string;
  cityName: string;
  cityPopulation: number;
  cityMilestone: number;
  date: Date;
  makeCreatorSupporter: boolean;
}

@QuestionSet({ name: 'city-info' })
class CityInfoQuestions {
  @Question({
    name: 'creatorId',
    message: `What is the Creator's Paradox Account ID?`
  })
  public parseCreatorId(val: string): string {
    const id = val.trim();
    if (!id) {
      throw `Creator ID must not be empty.`;
    }

    return id;
  }

  @Question({
    name: 'cityName',
    message: `What is the name of the city?`
  })
  public parseCityName(val: string): string {
    const name = val.trim();
    if (!name) {
      throw `City name must not be empty.`;
    }

    return name;
  }

  @Question({
    name: 'cityPopulation',
    message: `What is the population of the city?`,
    type: 'number'
  })
  public parseCityPopulation(val: number): number {
    if (Number.isNaN(val) || val < 0) {
      throw `Invalid population number, it must be a positive integer.`;
    }

    return val;
  }

  @Question({
    name: 'cityMilestone',
    message: `What is the milestone reached by the city?`,
    type: 'list',
    choices: milestones.map((milestone, index) => `${index + 1}. ${milestone}`)
  })
  public parseMilestone(val: string): number {
    return milestones.indexOf(nn(val.split('. ').at(1))) + 1;
  }

  @Question({
    name: 'date',
    message: `What was the date of the shot? (ddmmyy)`
  })
  public parseDate(val: string): Date {
    const date = dateFns.parse(val.trim(), 'ddMMyy', new Date());

    if (!dateFns.isValid(date)) {
      throw `Invalid date format, please use ddmmyy.`;
    }

    return date;
  }

  @Question({
    name: 'makeCreatorSupporter',
    message: `Make the Creator a supporter?`,
    type: 'confirm'
  })
  public parseMakeCreatorSupporter(val: boolean): boolean {
    return val;
  }
}

interface ConfirmCityInfoQuestionsResult {
  confirm: boolean;
}

@QuestionSet({ name: 'confirm-city-info' })
class ConfirmCityInfoQuestions {
  @Question({
    name: 'confirm',
    message: `Is the information correct?`,
    type: 'confirm'
  })
  public parseConfirm(val: boolean): boolean {
    return val;
  }
}

interface ConfirmUpdateQuestionsResult {
  confirm: boolean;
}

@QuestionSet({ name: 'confirm-update' })
class ConfirmUpdateQuestions {
  @Question({
    name: 'confirm',
    message: `Apply specified changes?`,
    type: 'confirm'
  })
  public parseConfirm(val: boolean): boolean {
    return val;
  }
}
