import { Provider } from '@nestjs/common';
import { importCityCommandProviders } from './import-city.command';
import { moderateCommandProviders } from './moderate.command';
import { resetCreatorIdCommandProviders } from './reset-creator-id.command';

// Lists commands but also their other nest-commander DI dependencies.
export const commands: Provider[] = [
    ...importCityCommandProviders,
    ...moderateCommandProviders,
    ...resetCreatorIdCommandProviders
];
