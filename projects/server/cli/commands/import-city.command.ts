import assert from 'node:assert/strict';
import * as path from 'node:path';
import { Inject, Provider } from '@nestjs/common';
import { Creator, Screenshot } from '@prisma/client';
import Bun from 'bun';
import { oneLine } from 'common-tags';
import * as dateFns from 'date-fns';
import {
    Command,
    CommandRunner,
    InquirerService,
    Question,
    QuestionSet
} from 'nest-commander';
import { Maybe } from '../../common';
import {
    CreatorService,
    PrismaService,
    ScreenshotService
} from '../../services'; // https://cs2.paradoxwikis.com/Progression#Milestones

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
        Interactive command to import screenshots images for a new or existing
        Creator from a directory.`,
    arguments: '<directoryPath>'
})
class ImportCityCommand extends CommandRunner {
    @Inject(InquirerService)
    private readonly inquirer!: InquirerService;

    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    @Inject(CreatorService)
    private readonly creatorService!: CreatorService;

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

            confirm = !!cityInfo;
            if (!confirm) {
                continue;
            }

            assert(cityInfo);

            // Check if the creator already exists.
            const existingCreator = await this.prisma.creator.findFirst({
                where: { creatorName: cityInfo.creatorName }
            });

            // Check if the creator already has screenshots for a city that has
            // the same name. Helps to avoid accidental re-imports.
            const existingCity =
                existingCreator &&
                (await this.prisma.screenshot.findFirst({
                    where: {
                        creatorId: existingCreator.id,
                        cityName: {
                            mode: 'insensitive',
                            equals: cityInfo.cityName
                        }
                    }
                }));

            // Ask the user to confirm the changes.
            confirm = await this.confirmChanges(
                existingCreator,
                existingCity,
                cityInfo,
                filePaths
            );

            if (!confirm) {
                continue;
            }

            // Create the creator if it doesn't exist.
            let creator = existingCreator;
            if (!creator) {
                const { creatorId, creator: createdCreator } =
                    await this.creatorService.createCreator(
                        cityInfo.creatorName
                    );

                console.info(oneLine`
                    Created Creator "${createdCreator.creatorName}",
                    Creator ID ${creatorId}.`);

                creator = createdCreator;
            }

            // Make the creator a supporter if requested.
            await this.maybeMakeCreatorSupporter(
                creator,
                existingCreator,
                cityInfo
            );

            // Import the screenshots.
            await this.ingestScreenshots(
                directoryPath,
                filePaths,
                creator,
                cityInfo
            );
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
            console.error(`No screenshots found in the directory.`);
            process.exit(1);
        }

        console.info(
            `Found ${filePaths.length} candidate file(s) in directory.`
        );

        return filePaths;
    }

    private async askForCityInfo(): Promise<
        CityInfoQuestionsResult | undefined
    > {
        const cityInfo = await this.inquirer.ask<CityInfoQuestionsResult>(
            'city-info',
            undefined
        );

        // Log the city information for the user to review.
        console.info(`\nPlease review the city information:`, cityInfo);

        return await this.inquirer
            .ask<ConfirmCityInfoQuestionsResult>('confirm-city-info', undefined)
            .then(result => (result.confirm ? cityInfo : undefined));
    }

    private async confirmChanges(
        existingCreator: Maybe<Creator>,
        existingCity: Maybe<Screenshot>,
        cityInfo: CityInfoQuestionsResult,
        filePaths: readonly string[]
    ): Promise<boolean> {
        console.info(`\nPlease review this carefully:`);

        existingCreator
            ? console.info(
                  ` - Use EXISTING Creator "${existingCreator.creatorName}" #${existingCreator.id}.`
              )
            : console.info(` - Create NEW Creator "${cityInfo.creatorName}".`);

        existingCity
            ? console.info(
                  ` - Add to EXISTING City "${existingCity.cityName}" #${existingCity.id}.`
              )
            : console.info(
                  ` - Create screenshot(s) for a NEW City "${cityInfo.cityName}".`
              );

        console.info(
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

            console.info(`Made Creator "${creator.creatorName}" a supporter.`);
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

            const screenshot = await this.screenshotService.ingestScreenshot(
                undefined,
                creator,
                cityInfo.cityName,
                cityInfo.cityMilestone,
                cityInfo.cityPopulation,
                cityInfo.date,
                Buffer.from(fileBytes)
            );

            console.info(
                `Imported screenshot "${filePath}", #${screenshot.id}`
            );
        }
    }
}

interface CityInfoQuestionsResult {
    creatorName: string;
    cityName: string;
    cityPopulation: number;
    cityMilestone: number;
    date: Date;
    makeCreatorSupporter: boolean;
}

@QuestionSet({ name: 'city-info' })
class CityInfoQuestions {
    @Question({
        name: 'creatorName',
        message: `What is the creator's name?`
    })
    public parseCreatorName(val: string): string {
        const name = val.trim();
        if (!name) {
            throw `Creator name must not be empty.`;
        }

        return name;
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
        choices: milestones.map(
            (milestone, index) => `${index + 1}. ${milestone}`
        )
    })
    public parseMilestone(val: string): number {
        // biome-ignore lint/style/noNonNullAssertion: input is safe
        return milestones.indexOf(val.split('. ')[1]!) + 1;
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

export const importCityCommandProviders: Provider[] = [
    ImportCityCommand,
    CityInfoQuestions,
    ConfirmCityInfoQuestions,
    ConfirmUpdateQuestions
];
