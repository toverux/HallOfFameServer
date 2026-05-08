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

- `mise build`: Build the application to check building the app works.
- `mise run:server`: Run the server to check app works (use timeout command to stop it after 5s).
- `mise check`: Run type checking and linting.
- `docker build -t halloffameserver . --progress=plain`: Check that the Docker build works.

## Boundaries

Never:

- Commit secrets, tokens, `.env` files, dumps, or credentials.
- Modify generated files unless the generation command was run.
- Reformat unrelated files.
- Change public API behavior without calling it out.
- Add large dependencies for small utilities.

Ask first before:

- Changing database schema.
- Changing authentication/authorization logic.
- Reworking architecture.
- Adding background jobs, queues, or external services.
- Performing destructive file or data operations.

## Preferred agent behavior

- Start by inspecting existing patterns.
- Make the smallest safe change.
- Prefer editing existing files over creating parallel abstractions.
- When uncertain, state the assumption and proceed conservatively.
- Do not produce broad refactors unless explicitly requested.
