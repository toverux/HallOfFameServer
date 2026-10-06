---
date: 2026-10-06
area: projects/server/services
symptoms:
  - "Sentry event extra shows '[Object]' or '[Array]' instead of the reported data"
tags: [sentry, extra, normalize, reporting]
---

# Sentry collapses nested objects in `extra`

## Problem

Data nested deeper than three levels in a report's `extra` reaches Sentry as `'[Object]'` or `'[Array]'`, so the event carries nothing to diagnose from.
A test spying on `sentry.captureMessage` still sees the full object.

## Root cause

`projects/server/sentry.ts` sets no `normalizeDepth`, so `@sentry/core` normalizes `extra` at its default depth of 3 (`node_modules/@sentry/core/build/esm/utils/prepareEvent.js`), after the capture call a spy observes.
`extra: { sample: [{ entry: {…} }] }` puts `entry`'s fields at depth 4.

## Fix

Serialize the nested payload into one string, as the Skyve sync does for its invalid entries (`projects/server/services/skyve.service.ts:202`):

```ts
const sample = JSON.stringify(invalidEntries.slice(0, SkyveService.reportedInvalidEntries));
```

## Prevention

Keep `extra` at most three levels deep, or pass anything nested as a JSON string.
