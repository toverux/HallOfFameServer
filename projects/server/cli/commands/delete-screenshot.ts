import { Inject, Provider } from '@nestjs/common';
import { CommandRunner, SubCommand } from 'nest-commander';
import { ScreenshotService } from '../../services';

@SubCommand({
    name: 'screenshot',
    arguments: '<id>',
    description: `Delete a screenshot from the database and blob storage.`
})
export class DeleteScreenshotCommand extends CommandRunner {
    @Inject(ScreenshotService)
    private readonly screenshotService!: ScreenshotService;

    public override async run(args: [string]): Promise<void> {
        const [id] = args;

        await this.screenshotService.deleteScreenshot(id);

        process.stdout.write(`Screenshot ${id} deleted successfully!\n`);
    }
}

export const deleteScreenshotCommandProviders: Provider[] = [
    DeleteScreenshotCommand
];
