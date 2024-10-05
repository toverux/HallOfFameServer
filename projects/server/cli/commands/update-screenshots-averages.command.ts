import { Inject, Provider } from '@nestjs/common';
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
        const updatedCount =
            await this.screenshotService.updateAverageViewsAndFavoritesPerDay(
                false
            );

        process.stdout.write(
            `Averages updates for ${updatedCount} screenshots.\n`
        );
    }
}

export const updateScreenshotsAveragesCommandProviders: Provider[] = [
    UpdateScreenshotsAveragesCommand
];
