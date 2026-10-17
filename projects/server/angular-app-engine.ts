import '@angular/compiler';
import type { AngularAppEngine, AngularAppEngineOptions } from '@angular/ssr';
import { Logger } from '@nestjs/common';
import { config } from './config';

export { createWebRequestFromNodeRequest, writeResponseToNodeResponse } from '@angular/ssr/node';

/**
 * Proxy headers Angular may build the request URL from, the ones the reverse proxy sets.
 * Fastify already trusts them (`trustProxy`), so this grants Angular the same trust.
 */
export const trustedProxyHeaders = ['x-forwarded-host', 'x-forwarded-proto'] as const;

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
  )) as { AngularAppEngine: new (options: AngularAppEngineOptions) => AngularAppEngine };

  // Angular answers 400 to a request whose host is not listed, so the public host is allowed here
  // rather than in angular.json, which would hardcode it at build time.
  angularAppEngine = new BuiltAppEngine({
    allowedHosts: [new URL(config.http.baseUrl).hostname],
    trustProxyHeaders: trustedProxyHeaders
  });
} catch (error) {
  if (config.env == 'production') {
    throw error;
  }

  // Tests run without a client build, so a missing one is expected there.
  if (config.env != 'test') {
    new Logger('Angular').error(
      `Failed to load Angular app engine manifest. Is the Angular app built?`,
      error
    );
  }
}
