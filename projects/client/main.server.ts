import { type BootstrapContext, bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config.server';

const bootstrap = (context: BootstrapContext) =>
  bootstrapApplication(AppComponent, appConfig, context);

// biome-ignore lint/style/noDefaultExport: needed per API contract
export default bootstrap;
