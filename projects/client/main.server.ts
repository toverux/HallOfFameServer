import type { ApplicationRef } from '@angular/core';
import { type BootstrapContext, bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config.server';

const bootstrap = (context: BootstrapContext): Promise<ApplicationRef> =>
  bootstrapApplication(AppComponent, appConfig, context);

// oxlint-disable-next-line import/no-default-export - Angular SSR entry requires a default export
export default bootstrap;
