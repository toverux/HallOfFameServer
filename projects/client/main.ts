import { bootstrapApplication } from '@angular/platform-browser';
import { iconsole } from '../server/iconsole';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

bootstrapApplication(AppComponent, appConfig).catch(err => iconsole.error(err));
