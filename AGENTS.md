<!-- toverux/scrolls version: 1.0.1 -->

# AGENTS.md

## Project overview

Hall of Fame is a mod for Cities: Skylines II that allows players to share and view screenshots.
This repository contains the server-side code that powers the mod's backend services, API endpoints, and web interface.
The game-side code lives in a separate repository, `../HallOfFame` (if checked out).

Players take up to 4K screenshots in-game, upload them, and browse others' shots as the main-menu background.
The service is designed to give every city visibility (each screenshot is shown as often as possible), while likes and trending still surface standout work.
There is no downvoting and no skill-based moderation, only removal of inappropriate content.

### Foxxy's HoF Viewer

[viewer.halloffame.mtq.io](https://viewer.halloffame.mtq.io) is a third-party web viewer for Hall of Fame content made by community member foxxy. Its code is not part of this repository, but a checkout is available at `../hof-viewer` (relative to this project's root, `dev` branch).

Screenshot pages live at `/city/<screenshotId>`, creator pages at `/?creator=<creatorId or creatorName>`; treat this URL scheme as an external contract.
This server provides tracked redirect endpoints to it (`GET /screenshots/:id/viewer`, `GET /creators/:id/viewer`) that increment the `viewerClicksCount` counters.

When changing public API behavior, pull the latest `dev` branch in `../hof-viewer` and search it for usages of the affected API before proceeding.

## Tech stack

- [mise-en-place](https://mise.jdx.dev): manages dev tools, env vars, and tasks for this repo.
- **Frontend**: Angular with SSR.
- **Backend**: Bun, NestJS, Fastify HTTP server.
- **API**: REST controllers and GraphQL (GraphQL Yoga with Pothos).
- **Database**: MongoDB with Prisma ORM.
- **ML Capabilities**: TensorFlow.js for image feature extraction.
- **Error Tracking**: Sentry.
- **Containerization**: Docker.
- **Toolchain**: oxfmt formats and oxlint lints, both extending `@toverux/blanc-hopital`, which also supplies the tsconfig bases; lefthook runs tsc/oxlint/oxfmt on staged files at pre-commit.

## Project settings

TypeScript, one root `tsconfig.json` covering the whole repo, `.agents/hooks` included; `tsconfig.app.json` narrows it to the three Angular entry points for the client build:

- TypeScript 6.0.3, extending `@toverux/blanc-hopital/tsconfig/strict` (strictest, minus `noPropertyAccessFromIndexSignature`) and `/tsconfig/bun`.
- `verbatimModuleSyntax` and `erasableSyntaxOnly` on; `isolatedModules` on, except off in the Angular build.
- `experimentalDecorators` and `emitDecoratorMetadata` on, for NestJS and Angular dependency injection.
- `noEmit` is restored to `false` (the bun base sets it true) because the Angular CLI cannot build otherwise.
- `moduleDetection: force` (from the bun base), so the import-free `.agents/hooks` scripts are modules rather than colliding global scripts.
- `#prisma-lib/*` maps to the generated `prisma/lib/*`, which `build:prisma:generate` writes and `.gitignore` excludes.
- Server, CLI, and `.agents/hooks` run on Bun; the Angular client runs in the browser, its SSR bundle inside the Bun server.

## Repository structure

- `prisma/schema.prisma` – Database schema
- `prisma/migrations` – Database migrations
- `projects/client` – Angular frontend code
- `projects/server` – NestJS backend code
- `projects/server/rest` – REST API controllers
- `projects/server/graphql` – GraphQL resolvers and schema
- `projects/server/cli` – Command-line interface tools
- `projects/server/services` – Business logic services
- `projects/server/testing` – Shared test infrastructure: preloads, factories, fakes, the `fetch` stub, the testing-module and test app builders
- `projects/server/http-tests` – HTTP request files for manual testing with JetBrains HTTP Client, not part of the test suite
- `projects/shared` – Shared code between client and server
- `.agents/rules` – Code style rules loaded into the agent's context
- `.agents/hooks` – Editor hooks (em-dash and line-length checks), wired in `.claude/settings.json`
- `.agents/skills` – Project skills, exposed to Claude Code through symlinks in `.claude/skills`
- `.github/workflows` – CI
- `docs/adr` – Architecture decision records; read before re-deciding something already settled.
- `docs/solutions` – Problem-shaped learnings captured by the `/compound` skill (root cause, gotcha, "what didn't work"); search it before diagnosing or re-deciding.

## Commands

`check:*` tasks are read-only and write nothing to tracked files; the in-place auto-fixers live under `fix:*`.

- `mise build`: Build the application to check building the app works.
- `mise run:server`: Run the server to check app works (use timeout command to stop it after 5s).
- `mise check:agents`: Verify type checking, linting, and formatting read-only, with optimized output.
- `mise check:agents:tsc`: Only type-checks the code, optimized output.
- `mise check:agents:oxlint`: Only lints the code, optimized output.
- `mise fix`: Apply the auto-fixes in place (oxlint `--fix`, then oxfmt).
- `mise fix:oxlint`, `mise fix:oxfmt`: The individual fixers.
- `docker build -t halloffameserver . --target release --progress=plain`: Check that the Docker build works; the full build's final stage runs `db push` and `migrate` against the dev MongoDB, reachable only with `--network=host`.
- To exercise a migration against real data, clone the collections it touches from the dev database (a production copy) into a scratch database on the same server with `$out: { db, coll }`, run the runner there with `mise exec -- env HOF_DATABASE_URL=mongodb://localhost/<scratch> bun projects/server/cli/main.ts migrate`, then drop the scratch database; the dev copy stays untouched.

Run `mise tasks` to see the full shortcut list; append arguments freely, mise passes them through (ex. `mise some:task --some-arg`).
Do NOT use npx to run commands; prefer mise shortcuts, or bun/bunx when no shortcut exists.

Always run the appropriate check commands and `mise test:agents` after changes, at the end of the editing session rather than mid-flight.

## Testing

- `mise test`: Run the test suite (`bun test`, server and shared code); arguments pass through, ex. a file path or `--test-name-pattern`.
- `mise test:agents`: The same, printing only failures.
- `mise test:openai`: Run the live tests (`*.live.test.ts`), which call the real OpenAI API with the `.env.local` key; each run costs money.

The first two start the dev MongoDB (`mise dev:db:start`), which the suite requires: each run gets its own throwaway database, emptied before every test.
Test files sit next to their subject as `*.test.ts` and import `describe`, `test`, `expect`, and friends explicitly from `bun:test`; the single root tsconfig would leak test globals into production code.
A test goes through the HTTP interface first, the way the mod and the viewer reach the server.
The suite fakes OpenAI, so after changing `ai-translator.service.ts` or the `openai` version in `bun.lock`, propose running `mise test:openai` at the end of the session and wait for approval.

Load the `hof-server-testing` skill before writing or changing a test, a factory, a fake, or the `fetch` stub.

## Glossary

User-facing terms map to these Prisma models (`prisma/schema.prisma`):

- **Creator** – a user account. Authenticated via a Paradox account ID or a local mod-generated ID (`CreatorIdProvider`); may attach social links (`CreatorSocial`) and be flagged as a supporter.
- **Screenshot** – an uploaded image (up to 4K); can be reported for moderation.
- **Favorite** – a "like" on a screenshot. Users see it as a like; the model is `Favorite`.
- **View** – records that a Creator has seen a Screenshot; backs the "show every city as often as possible" display algorithm and trending.
- **Ban** – moderation record; tracks hardware IDs and IPs to mitigate hostile multi-accounting.
- **Mod** – cached metadata about a Paradox mod, referenced loosely by `paradoxModId`.
- **ScreenshotFeatureEmbedding** – TensorFlow.js feature vector for a screenshot (image similarity).

## Guidelines

- Assert non-null with the project's `nn()` helper (`projects/shared/utils/type-assertion.ts`), not the `!` operator: `example(nn(value))` inline, or `nn.assert(value)` as a precondition when the value is used several times. `!` is for measured hot paths only, with the lint warning silenced.
- The same module provides `ensureBoolean()`, `ensureString()`, `ensureNumber()` and `ensureInEnum(value, enumType)`, each with an `.assert()` form, plus `unreachable(value)` for exhaustiveness in a `switch` default.
- Server and CLI code asserts invariants with `import assert from 'node:assert/strict'`; client code throws standard errors. Assertions are never for operational errors.
- The viewer URL scheme and the mod's HTTP wire format are external contracts: changing either is a public API change and must be called out.
- Bump `oxlint`, `oxfmt` and `oxlint-tsgolint` only together with `@toverux/blanc-hopital`, to the versions its `package.json` targets: its preset enables whole oxlint categories, so a lone oxlint bump switches on new rules and fails `mise check`.

## MCP servers

Two MCP servers are available to the agent, but they are not necessarily loaded by default:

- **Chrome DevTools MCP** – Drive a browser to test the web interface, inspect network requests, debug pages, etc.
- **MongoDB MCP** – Inspect and query the database directly.

If you want to use one of them (ex. to test your changes) and its tools are not available, ask the user to start it, then continue from there.

## Boundaries

Never:

- Create a git branch or commit work yourself unless the user expressly said so.
- Commit secrets, tokens, `.env` files, dumps, credentials.
- Modify generated files unless the generation command was run.
- Change public API behavior without calling it out.

Ask first before:

- Adding a dependency.
- Changing database schema or authentication/authorization logic.
- Reworking architecture, or adding background jobs, queues, external services.
- Performing destructive file or data operations.

## Preferred agent behavior

- Start by inspecting existing patterns.
- Prefer LSP over Grep/Glob/Read for code navigation.
- Make the smallest safe change, but speak up when a refactor is overdue.
- When uncertain, state the assumption and proceed conservatively.
- Actively propose updates to `AGENTS.md`, comments, or other docs when you detect drift.
