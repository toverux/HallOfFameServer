import '@angular/compiler';
import type { AngularAppEngine } from '@angular/ssr';
import { Logger } from '@nestjs/common';
import { config } from './config';

export { createWebRequestFromNodeRequest, writeResponseToNodeResponse } from '@angular/ssr/node';

export function getAngularAppEngine(): AngularAppEngine {
  if (!angularAppEngine) {
    throw new Error(`Angular application was not built.`);
  }

  return angularAppEngine;
}

let angularAppEngine: AngularAppEngine | undefined;

try {
  const { AngularAppEngine: BuiltAppEngine } = (await import(
    // @ts-expect-error resolved at runtime in prod builds.
    '../../dist/server/server.mjs'
  )) as { AngularAppEngine: new () => AngularAppEngine };

  angularAppEngine = new BuiltAppEngine();
} catch (error) {
  if (config.env == 'production') {
    throw error;
  }

  new Logger('Angular').error(
    `Failed to load Angular app engine manifest. Is the Angular app built?`,
    error
  );
}
