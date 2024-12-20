import { ApplicationConfig, mergeApplicationConfig } from '@angular/core';
import { provideServerRendering } from '@angular/platform-server';
import { provideServerRoutesConfig } from '@angular/ssr';
import { appConfig as config } from './app.config';
import { serverRoutes } from './app.routes.server';

export const appConfig: ApplicationConfig = mergeApplicationConfig(config, {
    providers: [
        provideServerRendering(),
        provideServerRoutesConfig(serverRoutes)
    ]
});
