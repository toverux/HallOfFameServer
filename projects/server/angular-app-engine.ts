import '@angular/compiler';
import type { AngularAppEngine } from '@angular/ssr';
import { Logger } from '@nestjs/common';
import { config } from './config';

export {
  createWebRequestFromNodeRequest,
  writeResponseToNodeResponse
} from '@angular/ssr/node';

export let angularAppEngine: AngularAppEngine | undefined;

try {
  const { AngularAppEngine: BuiltAppEngine } = await import(
    // biome-ignore lint/complexity/noUselessStringConcat: workaround so Biome doesn't follow the import and analyzes dist files, despite the force-ignore pattern for dist in Biome's config (this is a bug).
    '../../dist/server/server' + '.mjs'
  );

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
