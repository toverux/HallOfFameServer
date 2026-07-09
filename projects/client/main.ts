import { bootstrapApplication } from '@angular/platform-browser';
import { iconsole } from '../shared/iconsole';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

try {
  await bootstrapApplication(AppComponent, appConfig);
} catch (error) {
  iconsole.error(error);
}
