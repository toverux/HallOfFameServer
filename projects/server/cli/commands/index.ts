import { Provider } from '@nestjs/common';
import { importCityCommandInjectables } from './import-city.command';

// Lists commands but also their other nest-commander DI dependencies.
export const commands: Provider[] = [...importCityCommandInjectables];
