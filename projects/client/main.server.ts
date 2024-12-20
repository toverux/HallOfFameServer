import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config.server';

const bootstrap = () => bootstrapApplication(AppComponent, appConfig);

// biome-ignore lint/style/noDefaultExport: needed per API contract
export default bootstrap;
