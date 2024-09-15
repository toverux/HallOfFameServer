/**
 * This file initializes Sentry for the server-side application.
 * It must be imported before any other modules.
 */

import * as Sentry from '@sentry/bun';
import { config } from './config';

Sentry.init({
    dsn:
        config.sentry.dsn == 'disabled'
            ? // The type is wrong, undefined value is permitted.
              (undefined as unknown as string)
            : config.sentry.dsn,
    environment: config.env,
    sampleRate: 1.0,
    tracesSampleRate: config.env == 'development' ? 1.0 : 0.05
});
