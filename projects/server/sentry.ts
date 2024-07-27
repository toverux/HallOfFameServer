/**
 * This file initializes Sentry for the server-side application.
 * It must be imported before any other modules.
 */

import * as Sentry from '@sentry/bun';
import { config } from './config';

Sentry.init({
    // The property concatenation is just a trick so TypeScript doesn't complain
    // about undefined, which is in fact supported and disables the SDK.
    ['dsn' + '']:
        config.sentry.dsn == 'disabled' ? undefined : config.sentry.dsn,
    environment: config.env,
    sampleRate: 1.0,
    tracesSampleRate: config.env == 'development' ? 1.0 : 0.05
});
