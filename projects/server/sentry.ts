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
  sampleRate: 1,
  // Every other category defaults to collected.
  dataCollection: { userInfo: true },
  tracesSampleRate: config.env == 'development' ? 1 : productionTracesSampleRate,
  integrations: [Sentry.extraErrorDataIntegration(), Sentry.openAIIntegration()]
});
