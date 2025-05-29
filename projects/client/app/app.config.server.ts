import { ApplicationConfig, mergeApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';
import { appConfig as config } from './app.config';
import { serverRoutes } from './app.routes.server';

export const appConfig: ApplicationConfig = mergeApplicationConfig(config, {
  providers: [provideServerRendering(withRoutes(serverRoutes))]
});
