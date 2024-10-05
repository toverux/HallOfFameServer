import { Provider } from '@nestjs/common';
import { balanceCommandProviders } from './balance.command';
import { deleteScreenshotCommandProviders } from './delete-screenshot';
import { deleteCommandProviders } from './delete.command';
import { importCityCommandProviders } from './import-city.command';
import { moderateCommandProviders } from './moderate.command';
import { updateScreenshotsAveragesCommandProviders } from './update-screenshots-averages.command';

// Lists commands but also their other nest-commander DI dependencies.
export const commands: Provider[] = [
    ...balanceCommandProviders,
    ...deleteCommandProviders,
    ...deleteScreenshotCommandProviders,
    ...importCityCommandProviders,
    ...moderateCommandProviders,
    ...updateScreenshotsAveragesCommandProviders
];
