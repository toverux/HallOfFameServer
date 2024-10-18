import { Inject, Provider } from '@nestjs/common';
import chalk from 'chalk';
import { Command, CommandRunner } from 'nest-commander';
import { ScreenshotService } from '../../services';

@Command({
    name: 'update-screenshots-averages',
    description: `Update average view and favorites per day for each screenshot.`
})
class UpdateScreenshotsAveragesCommand extends CommandRunner {
    @Inject(ScreenshotService)
    private readonly screenshotService!: ScreenshotService;

    public override async run(): Promise<void> {
        await this.screenshotService.updateAverageViewsAndFavoritesPerDay(
            false
        );

        console.info(chalk.bold`Done.`);
    }
}

export const updateScreenshotsAveragesCommandProviders: Provider[] = [
    UpdateScreenshotsAveragesCommand
];
