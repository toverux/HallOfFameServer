import { Provider } from '@nestjs/common';
import { deleteCreatorCommandProviders } from './delete-creator';
import { deleteScreenshotCommandProviders } from './delete-screenshot';
import { deleteCommandProviders } from './delete.command';
import { importCityCommandProviders } from './import-city.command';
import { mergeCreatorsCommandProviders } from './merge-creators.command';
import { moderateCommandProviders } from './moderate.command';
import { updateScreenshotsAveragesCommandProviders } from './update-screenshots-averages.command';

// Lists commands but also their other nest-commander DI dependencies.
export const commands: Provider[] = [
  ...deleteCommandProviders,
  ...deleteScreenshotCommandProviders,
  ...deleteCreatorCommandProviders,
  ...importCityCommandProviders,
  ...mergeCreatorsCommandProviders,
  ...moderateCommandProviders,
  ...updateScreenshotsAveragesCommandProviders
];
