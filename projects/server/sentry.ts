/**
 * This file initializes Sentry for the server-side application.
 * It must be imported before any other modules.
 */

import * as Sentry from '@sentry/bun';
import { config } from './config';

// Sample 5% of traces in production to keep measuring impact on performance reasonable and still
// capture a significant amount of data.
const productionTracesSampleRate = 0.05;

Sentry.init({
  dsn: config.sentry.dsn == 'disabled' ? undefined : config.sentry.dsn,
  environment: config.env,
  enableLogs: true,
  sampleRate: 1,
  sendDefaultPii: true,
  tracesSampleRate: config.env == 'development' ? 1 : productionTracesSampleRate,
  integrations: [Sentry.extraErrorDataIntegration(), Sentry.openAIIntegration()]
});
