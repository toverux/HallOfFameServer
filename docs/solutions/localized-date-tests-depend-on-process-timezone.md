---
date: 2026-09-12
area: projects/server/services/date-fns-localization.service.ts
symptoms:
  - "createdAtFormatted in an HTTP test is off by the machine's UTC offset"
tags: [dates, timezone, date-fns, localization, testing]
---

# Localized date tests depend on the process timezone

## Problem

Tests pinning `createdAtFormatted` strings, like the localized-dates cases in `screenshot.controller.test.ts`, only pass when the process runs in UTC.

## Root cause

`DateFnsLocalizationService.applyTimezoneOffsetOnDateForRequest` adds the `X-Timezone-Offset` minutes to the UTC instant (`date-fns-localization.service.ts:53`), then `ScreenshotService.serialize` formats it with date-fns `format` (`screenshot.service.ts:685`), which reads local time.
The output is right only when local time is UTC, as in production's Docker image.
`.env` sets `TZ=UTC`; mise loads it, and the test environment preload re-applies it.

## Prevention

- Keep `TZ=UTC` in `.env`.
- Pin formatted dates for UTC, and freeze the clock with `setSystemTime` from `bun:test` when asserting `createdAtFormattedDistance`.
