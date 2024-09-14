import { Provider } from '@nestjs/common';
import { deleteScreenshotCommandProviders } from './delete-screenshot';
import { deleteCommandProviders } from './delete.command';
import { importCityCommandProviders } from './import-city.command';
import { moderateCommandProviders } from './moderate.command';

// Lists commands but also their other nest-commander DI dependencies.
export const commands: Provider[] = [
    ...deleteCommandProviders,
    ...deleteScreenshotCommandProviders,
    ...importCityCommandProviders,
    ...moderateCommandProviders
];
