---
date: 2026-11-16
area: projects/server/services
symptoms:
  - "Mod error events in Sentry show runtime 'node' and the server's version"
  - "A relayed event's user carries the server's IP and city"
tags: [sentry, client, scope, runtime, ip, mod-errors]
---

# A second Sentry client leaks the server's state into relayed events

## Problem

Events the server relays for someone else (the mod's error reports, `mod-error-report.service.ts`) go through a second Sentry client, and each default of that client describes the server instead of the reporter: its runtime, its IP, its request's scope.

## What didn't work

- `Sentry.init()` for the second client: it installs the process-wide async context strategy, which belongs to the server's client.

## Root cause

- `NodeClient`'s constructor defaults `runtime` to `{ name: 'node', version }` (`node_modules/@sentry/node/build/cjs/sdk/client.js:21`), stamped on every event that sets none (`@sentry/core/build/cjs/server-runtime-client.js:162`).
- The same constructor adds `process.on('beforeExit')` listeners (`client.js:41`), which only `close()` removes.
- Sentry stores the sending address as the user's IP unless the event says otherwise, and fills `geo` from the connection whatever the event says.

## Fix

Build `new NodeClient({…})` directly, never `init()`-ed, and per event (`mod-error-report.service.ts:131-165`):

- capture with `client.captureEvent(event, {}, scope)` inside `withIsolationScope(new Scope(), …)`, so the request's breadcrumbs and data stay off it;
- set `contexts.runtime` to the reporter's runtime;
- send `sdk: { settings: { infer_ip: 'never' } }`; `geo` needs the project's "Prevent Storing of IP Addresses" setting on;
- `close()` the client in `onApplicationShutdown`.

## Prevention

Assert relayed events at a fake ingest on the fetch stub (`testing/fake-sentry-ingest.ts`), not a spied capture: only the envelope shows what the client added after the capture call.
