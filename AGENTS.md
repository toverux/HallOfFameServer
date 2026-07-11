# AGENTS.md

## Project overview

Hall of Fame is a mod for Cities: Skylines II that allows players to share and view screenshots.
This repository contains the server-side code that powers the mod's backend services, API endpoints,
and web interface.

Players take up to 4K screenshots in-game, upload them, and browse others' shots as the main-menu
background. The service is designed to give every city visibility (each screenshot is shown as often
as possible), while likes and trending still surface standout work. There is no downvoting and no
skill-based moderation, only removal of inappropriate content.

## Domain concepts

User-facing terms map to these Prisma models (`prisma/schema.prisma`):

- **Creator** – a user account. Authenticated via a Paradox account ID or a local mod-generated ID
  (`CreatorIdProvider`); may attach social links (`CreatorSocial`) and be flagged as a supporter.
- **Screenshot** – an uploaded image (up to 4K); can be reported for moderation.
- **Favorite** – a "like" on a screenshot.
- **View** – records that a Creator has seen a Screenshot; backs the "show every city as often as
  possible" display algorithm and trending.
- **Ban** – moderation record; tracks hardware IDs and IPs to mitigate hostile multi-accounting.
- **Mod** – cached metadata about a Paradox mod, referenced loosely by `paradoxModId`.
- **ScreenshotFeatureEmbedding** – TensorFlow.js feature vector for a screenshot (image similarity).

## Tech stack

- [mise-en-place](https://mise.jdx.dev): A tool to manage dev tools, env vars, and tasks per project.
- **Frontend**: Angular with SSR.
- **Backend**: Bun, NestJS, Fastify HTTP server.
- **API**: REST controllers and GraphQL (GraphQL Yoga).
- **Database**: MongoDB with Prisma ORM.
- **ML Capabilities**: TensorFlow.js for image feature extraction.
- **Error Tracking**: Sentry.
- **Containerization**: Docker.

## Repository structure

- `prisma/schema.prisma` – Database schema
- `prisma/migrations` – Database migrations
- `projects/client` – Angular frontend code
- `projects/server` – NestJS backend code
- `projects/server/rest` – REST API controllers
- `projects/server/graphql` – GraphQL resolvers and schema
- `projects/server/cli` – Command-line interface tools
- `projects/server/services` – Business logic services
- `projects/shared` – Shared code between client and server
- `test` – HTTP request files for testing with JetBrains HTTP Client

## Commands

You can run `mise tasks` to see the full list of shortcut commands. Do NOT use npx to run commands, always prefer mise shortcuts, or bun/bunx if there is no dedicated mise shortcut.

- `mise build`: Build the application to check building the app works.
- `mise run:server`: Run the server to check app works (use timeout command to stop it after 5s).
- `mise check:agents`: Run type checking, formatting, and linting, with optimized output.
- `mise check:agents:tsc`: Only type-checks the code, optimized output.
- `mise check:agents:oxlint`: Only lints the code, optimized output.
- `docker build -t halloffameserver . --progress=plain`: Check that the Docker build works.

Tip: you can append arguments to mise shortcuts, mise will pass them through, ex. `mise some:task --some-arg`.

Always run the appropriate check/test commands after performing changes; but do it at the end of the editing session, not in the middle.

## Boundaries

Never:

- Create a git branch, stage files, or commit work yourself unless the user expressly told you so.
- Commit secrets, tokens, `.env` files, dumps, or credentials.
- Modify generated files unless the generation command was run.
- Change public API behavior without calling it out.
- Add large dependencies for small utilities.

Ask first before:

- Adding a dependency.
- Changing database schema.
- Changing authentication/authorization logic.
- Reworking architecture.
- Adding background jobs, queues, or external services.
- Performing destructive file or data operations.

## Preferred agent behavior

- Start by inspecting existing patterns.
- Prefer LSP over Grep/Glob/Read for code navigation.
- Make the smallest safe change, but if you think a refactor is overdue, speak up.
- Prefer editing existing files over creating parallel abstractions.
- When uncertain, state the assumption and proceed conservatively.
- Propose updates to `AGENTS.md` or `docs/` when you notice a pattern or introduced changes that deserve to be documented for future sessions.
