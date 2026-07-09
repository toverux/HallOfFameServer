# AGENTS.md

## Project overview

Hall of Fame is a mod for Cities: Skylines II that allows players to share and view screenshots.
This repository contains the server-side code that powers the mod's backend services, API endpoints,
and web interface.

## Tech Stack

- **Frontend**: Angular with SSR.
- **Backend**: Bun, NestJS, Fastify HTTP server.
- **Database**: MongoDB with Prisma ORM.
- **ML Capabilities**: TensorFlow.js for image feature extraction.
- **Error Tracking**: Sentry.
- **Containerization**: Docker.

## Repository layout

- `prisma/schema.prisma` – Database schema
- `prisma/migrations` – Database migrations
- `projects/client` – Angular frontend code
- `projects/server` – NestJS backend code
- `projects/server/api` – API endpoints and controllers
- `projects/server/cli` – Command-line interface tools
- `projects/server/services` – Business logic services
- `projects/shared` – Shared code between client and server
- `test` – HTTP request files for testing with JetBrains HTTP Client

## Commands

You can run `mise tasks` to see the full list of shortcut commands. Do NOT use `npx` to run
commands, always prefer mise shortcuts, or bun/bunx if there is no mise shortcut.

- `mise build`: Build the application to check building the app works.
- `mise run:server`: Run the server to check app works (use timeout command to stop it after 5s).
- `mise check:agents`: Run type checking, formatting, and linting, with optimized output.
- `mise check:agents:tsc`: Only type-checks the code, optimized output.
- `mise check:agents:oxlint`: Only lints the code, optimized output.
- `docker build -t halloffameserver . --progress=plain`: Check that the Docker build works.

Always run the appropriate check/test commands after performing changes. But do it at the end of the
editing session, not in the middle.

Tip: you can append arguments to mise shortcuts, mise will pass them through, ex.
`mise some:task --some-arg`.

## Boundaries

- Never create a git branch or commit work yourself unless the user expressly told you so.
- Never modify generated files unless the generation command was run.
- Never reformat unrelated files.
- Ask before adding a dependency.
- Ask before reworking architecture.
- Ask before performing destructive file or data operations.

## Preferred agent behavior

- **Prefer LSP over Grep/Glob/Read for code navigation**.
- Start by inspecting existing patterns.
- NEVER use em dashes (—) in comments, docblocks, and docs, when you see one, remove it.
- Respect a strict 100-character line length limit, comments included (include docblock formatting
  in the count). One-line lint suppression comments are exempt from this limit.
- Update `AGENTS.md` or docs under `docs/` to keep them up to date or when you notice a pattern.
- Make the smallest safe change — BUT SPEAK UP if you think a refactor is overdue.
- Prefer editing existing files over creating parallel abstractions.
- When uncertain, state the assumption and proceed conservatively.
