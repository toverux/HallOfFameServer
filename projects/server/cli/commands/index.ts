import { Provider } from '@nestjs/common';
import { importCityCommandProviders } from './import-city.command';
import { moderateCommandProviders } from './moderate.command';

// Lists commands but also their other nest-commander DI dependencies.
export const commands: Provider[] = [
    ...importCityCommandProviders,
    ...moderateCommandProviders
];
