import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Inject, Provider } from '@nestjs/common';
import { Creator, Screenshot } from '@prisma/client';
import chalk from 'chalk';
import { oneLine } from 'common-tags';
import {
    Command,
    CommandRunner,
    InquirerService,
    Option,
    Question,
    QuestionSet
} from 'nest-commander';
import open from 'open';
import { assertUnreachable } from '../../common';
import {
    BanService,
    PrismaService,
    ScreenshotService,
    ScreenshotStorageService
} from '../../services';

const moderationActions = {
    approve: 'APPROVE Screenshot (discard report, mark approved)',
    delete: 'DELETE Screenshot',
    ban: 'DELETE Screenshot & Ban Creator'
};

type ModerationAction = keyof typeof moderationActions;

@Command({
    name: 'moderate',
    description: oneLine`
        Interactive command to moderate screenshots that have been reported by
        users.`
})
class ModerateCommand extends CommandRunner {
    @Inject(InquirerService)
    private readonly inquirer!: InquirerService;

    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    @Inject(ScreenshotService)
    private readonly screenshotService!: ScreenshotService;

    @Inject(ScreenshotStorageService)
    private readonly screenshotStorage!: ScreenshotStorageService;

    @Inject(BanService)
    private readonly ban!: BanService;

    @Option({
        name: 'download',
        flags: '-d, --download [boolean]',
        description: oneLine`
            Download each screenshot being moderated to a temp file and open it
            for review.`
    })
    public parseBoolean(val: string): boolean {
        return JSON.parse(val);
    }

    public override async run(
        _args: never,
        options: { readonly download: boolean }
    ): Promise<void> {
        const reportedScreenshotFilePath = path.join(os.tmpdir(), 'hof-reported-screenshot.jpg');

        while (true) {
            const screenshot = await this.prisma.screenshot.findFirst({
                where: { isReported: true },
                include: { creator: true, reportedBy: true }
            });

            if (!screenshot) {
                console.info(chalk.bold`All screenshots have been moderated.`);
                break;
            }

            const reportedCount = await this.prisma.screenshot.count({
                where: { isReported: true }
            });

            console.info(`There are ${reportedCount} screenshots left to moderate.`);

            console.info(oneLine`
                Screenshot: City "${screenshot.cityName}",
                Creator "${screenshot.creator.creatorName ?? '<anonymous>'}"
                (reported by "${screenshot.reportedBy?.creatorName ?? '<anonymous>'}")`);

            console.info(`URL: ${this.screenshotService.getBlobUrl(screenshot.imageUrlFHD)}`);

            if (options.download) {
                await this.screenshotStorage.downloadScreenshotToFile(
                    screenshot.imageUrlFHD,
                    reportedScreenshotFilePath
                );

                await open(reportedScreenshotFilePath);
            }

            const { action } = await this.inquirer.ask<ModerationActionQuestionsResult>(
                'moderation-action',
                undefined
            );

            switch (action) {
                case 'approve': {
                    await this.screenshotService.unmarkReported(screenshot.id);

                    console.info(`APPROVED screenshot.`);
                    break;
                }
                case 'delete': {
                    await this.screenshotService.deleteScreenshot(screenshot.id);

                    console.info(`DELETED screenshot.`);
                    break;
                }
                case 'ban': {
                    await this.banCreator(screenshot.creator, screenshot);

                    console.info(`DELETED screenshot and BANNED creator.`);
                    break;
                }
                default:
                    assertUnreachable(action);
            }
        }

        if (await fs.exists(reportedScreenshotFilePath)) {
            await fs.rm(reportedScreenshotFilePath);
        }
    }

    private async banCreator(creator: Creator, screenshot: Screenshot): Promise<void> {
        await this.ban.banCreator(
            creator,
            oneLine`
            one or more screenshots for city "${screenshot.cityName}" was
            reported and judged to be inappropriate by our moderation team`
        );

        await this.screenshotService.deleteScreenshot(screenshot.id);
    }
}

interface ModerationActionQuestionsResult {
    action: ModerationAction;
}

@QuestionSet({ name: 'moderation-action' })
class ModerationActionQuestions {
    @Question({
        name: 'action',
        message: `What action to take?`,
        type: 'list',
        choices: Object.values(moderationActions)
    })
    public parseModerationAction(val: string): ModerationAction {
        return Object.keys(moderationActions).find(
            key => moderationActions[key as ModerationAction] == val
        ) as ModerationAction;
    }
}

export const moderateCommandProviders: Provider[] = [ModerateCommand, ModerationActionQuestions];
