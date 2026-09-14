---
name: hof-server-testing
description: Write and run the server's bun tests. Use when writing or changing a server or shared test, choosing the seam a test goes through, adding a factory, fake, or fetch stub, or when a test fails on the database, the environment, or an unexpected fetch.
---

# Server Testing

The server's tests run under `bun test`, one file after another in one process, with every external service faked.

## Run

Check a test for flakiness with separate `bun test` runs, not `--rerun-each`: see `docs/solutions/rerun-each-breaks-test-database-preload.md`.

## Choose the seam

Take the first seam that reaches the behavior:

1. **HTTP**, the default and the seam of the first failing test in TDD: build the app with `createTestApp()`, then send requests with `app.inject()` against `/api/v1`.
   It pins the wire format the mod and the viewer depend on, and exercises the services underneath.
2. **Service**, through `createServiceTestingModule()`: only for behavior no route reaches (CLI or cron work) or a case matrix too wide to cover cheaply over HTTP.
3. **Pure function**, for a rule the public path reaches only through heavy setup: extract it as an exported function beside its caller rather than reach into a private member, then test input against output, with no database or Nest (the upload validators in `screenshot.controller.ts`).
   `projects/shared` utilities test the same way.

## The preloads

`bunfig.toml` preloads run before any test file:

- `preload-environment.ts` overwrites the environment with inert values for every external service and the run's own database URL.
  The configuration is read once, when its module loads: a test needing another value sets it in this preload.
- `preload-database.ts` gives the run a throwaway database with the schema's indexes, emptied before each test.
  Each test starts empty and seeds what it needs; tests share the database, so they run one at a time.

`test` is an environment of its own: branches comparing `NODE_ENV` against `development` or `production` take neither.
No cron runs, and the app logs only errors, so a passing run prints nothing.

## Seed with factories

- `factories.ts` inserts one record per call, with deterministic, production-like defaults, never random.
  Override only the fields the test is about, and pass related records in (a screenshot takes its creator).
  Add a factory or a default when a test needs one.
- `identifiers.ts` holds identifiers no factory hands out, for what a test adds beside the seeded records.
- The upload fixture is `projects/shared/assets/healthcheck-test-image.jpg`.

## Fakes and the fetch stub

- `fakes.ts` holds handwritten in-memory stand-ins for the services that reach external systems, recording what they receive; assert on those records.
  They implement what the app reaches over HTTP: add a CLI-only method when a test needs it.
- `createTestApp()` puts the fakes in place through `overrideProvider()` and exposes them on the returned `TestApp`; pass `ValueProvider`s to `createTestApp([...])` to replace a provider for one suite.
- `createServiceTestingModule()` provides nothing but `PrismaService`: list the fakes a service depends on beside it.
- The global `fetch` is `fetchStub` for the whole run.
  Stub each expected URL with `fetchStub.respondWithJson()` before the request: any other request fails the test.
- Bun's `spyOn` and `mock` serve one-offs: a call assertion, a forced rejection, a silenced logger.
  Restore a spy on a shared object (`Logger.prototype`) with `mockRestore()` even when the test fails: in a `finally`, or before the first assertion.

## HTTP tests

- A fresh app per test: `createTestApp()` in `beforeEach`, `await testApp.app.close()` in `afterEach`.
- Send the mod's credentials with `headers: modHeaders(creator)`, the `CreatorID` form with `authorization: CreatorID <creatorId>`.
- Cover the 401 of an authenticated route and the 403 of an owner-only one.
- Await `testApp.backgroundTasks.settled()` before asserting on work a request left running.
- Read the database through `testApp.prisma` for state no route serializes, such as a click counter.
- Freeze the clock with `setSystemTime()` from `bun:test` to assert a relative date: see `docs/solutions/localized-date-tests-depend-on-process-timezone.md`.

## Assertions

- Assert a body against an explicit expected shape with `toEqual`, written inline rather than as a snapshot, so a wire-format change shows up in review as an edited expectation.
- Build a serialized record's expected shape with `payloads.ts`, passing the route's own fields as overrides.
- An error body is the JSON the mod parses: assert all of `{ statusCode, message, error }`.
- Write `expect(promise).resolves` and `.rejects` without `await`: in Bun they block until the promise settles.
  They refuse a Prisma query, which is a thenable rather than a Promise: await the query and assert on its value.

## Lint

Test files lint like production code, plus oxlint's `jest` plugin, warnings denied.
Setup runs in hooks (`jest/require-hook`); module-level `const`s are fine.
Relax another rule for tests only when a real test hits it: an override in `oxlint.config.ts` with its reason when it holds for tests in general, otherwise a one-line suppression with its reason (`// oxlint-disable-next-line no-await-in-loop - sequential factory numbering`).

## Live tests

A `*.live.test.ts` file calls the real OpenAI API, outside `bun test`, whose `bunfig.toml` ignores the suffix: `mise test:openai` passes the files by path.
It runs under `bunfig.live.toml`, whose one preload, `preload-live.ts`, replaces the three in `bunfig.toml`, requires the real key, and raises the timeout for reasoning models: no database, no fetch stub, no fakes.
Its tests run concurrently, so each one stands alone.
It goes through the service, built with `Test.createTestingModule()` and the production `openAiProvider`, because it pins the API's side of the contract rather than our wiring.
Pick inputs with one certain answer and assert on what that answer always holds (a locale, a script, a form the prompt demands), so a failure means the request or the prompt broke.
