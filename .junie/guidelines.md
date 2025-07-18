# Hall of Fame Server Guidelines

1. CONTEXT FIRST — NO GUESSWORK
- DO NOT WRITE A SINGLE LINE OF CODE UNTIL YOU UNDERSTAND THE SYSTEM.
- IMMEDIATELY LIST FILES IN THE TARGET DIRECTORY.
- ASK ONLY THE NECESSARY CLARIFYING QUESTIONS. NO FLUFF.
- DETECT AND FOLLOW EXISTING PATTERNS. MATCH STYLE, STRUCTURE, AND LOGIC.
- IDENTIFY ENVIRONMENT VARIABLES, CONFIG FILES, AND SYSTEM DEPENDENCIES.

2. CHALLENGE THE REQUEST — DON’T BLINDLY FOLLOW
- IDENTIFY EDGE CASES IMMEDIATELY.
- ASK SPECIFICALLY: WHAT ARE THE INPUTS? OUTPUTS? CONSTRAINTS?
- QUESTION EVERYTHING THAT IS VAGUE OR ASSUMED.
- REFINE THE TASK UNTIL THE GOAL IS BULLET-PROOF.

3. HOLD THE STANDARD — EVERY LINE MUST COUNT
- CODE MUST BE MODULAR, TESTABLE, CLEAN.
- COMMENT METHODS. USE DOCSTRINGS. EXPLAIN LOGIC.
- SUGGEST BEST PRACTICES IF CURRENT APPROACH IS OUTDATED.
- IF YOU KNOW A BETTER WAY — SPEAK UP.

4. ZOOM OUT — THINK BIGGER THAN JUST THE FILE
- DON’T PATCH. DESIGN.
- THINK ABOUT MAINTAINABILITY, USABILITY, SCALABILITY.
- CONSIDER ALL COMPONENTS (FRONTEND, BACKEND, DB, USER INTERFACE).
- PLAN FOR THE USER EXPERIENCE. NOT JUST THE FUNCTIONALITY.

5. WEB TERMINOLOGY — SPEAK THE RIGHT LANGUAGE
- FRAME SOLUTIONS IN TERMS OF APIs, ROUTES, COMPONENT STRUCTURE, DATA FLOW.
- UNDERSTAND FRONTEND-BACKEND INTERACTIONS BEFORE CHANGING EITHER.

6. ONE FILE, ONE RESPONSE
- DO NOT SPLIT FILE RESPONSES.
- DO NOT RENAME METHODS UNLESS ABSOLUTELY NECESSARY.
- SEEK APPROVAL ONLY WHEN THE TASK NEEDS CLARITY — OTHERWISE, EXECUTE.

7. ENFORCE STRICT STANDARDS
- CLEAN CODE, CLEAN STRUCTURE.
- 1600 LINES PER FILE MAX.
- HIGHLIGHT ANY FILE THAT IS GROWING BEYOND CONTROL.
- USE LINTERS, FORMATTERS. IF THEY’RE MISSING — FLAG IT.

8. MOVE FAST, BUT WITH CONTEXT
- ALWAYS BULLET YOUR PLAN BEFORE EXECUTION:
- WHAT YOU’RE DOING
- WHY YOU’RE DOING IT
- WHAT YOU EXPECT TO CHANGE

ABSOLUTE DO-NOTS:
- DO NOT CHANGE TRANSLATION KEYS UNLESS SPECIFIED.
- DO NOT ADD LOGIC THAT DOESN’T NEED TO BE THERE.
- DO NOT WRAP EVERYTHING IN TRY-CATCH. THINK FIRST.
- DO NOT SPAM FILES WITH NON-ESSENTIAL COMPONENTS.
- DO NOT CREATE SIDE EFFECTS WITHOUT MENTIONING THEM.

REMEMBER:
- YOUR WORK ISN’T DONE UNTIL THE SYSTEM IS STABLE.
- THINK THROUGH ALL CONSEQUENCES OF YOUR CHANGES.
- IF YOU BREAK SOMETHING IN ONE PLACE, FIX IT ACROSS THE PROJECT.
- CLEANUP. DOCUMENT. REVIEW.

THINK LIKE A HUMAN:
- CONSIDER NATURAL BEHAVIOR.
- HOW WOULD A USER INTERACT WITH THIS?
- WHAT HAPPENS WHEN SOMETHING FAILS?
- HOW CAN YOU MAKE THIS FEEL SEAMLESS?

EXECUTE LIKE A PROFESSIONAL CODER. THINK LIKE AN ARCHITECT. DELIVER LIKE A LEADER.

## Project Overview

Hall of Fame is a mod for Cities: Skylines II that allows players to share and view screenshots.
This repository contains the server-side code that powers the mod's backend services, API endpoints,
and web interface.

## Tech Stack

- **TypeScript**: [see guidelines](/.junie/typescript.md).
- **Backend**: NestJS with Fastify HTTP server.
- **Frontend**: Angular with SSR (Server-Side Rendering).
- **Database**: MongoDB with Prisma ORM.
- **Runtime**: Bun (with Node.js for Angular build).
- **ML Capabilities**: TensorFlow.js for image feature extraction.
- **Error Tracking**: Sentry.
- **Containerization**: Docker.

## Project Structure

- `prisma` – Database schema and migrations
- `projects/client` – Angular frontend code
- `projects/server` – NestJS backend code
- `projects/server/api` – API endpoints and controllers
- `projects/server/cli` – Command-line interface tools
- `projects/server/services` – Business logic services
- `projects/server/webhooks` – Webhook handlers
- `projects/shared` – Shared code between client and server
- `test` – HTTP request files for testing with JetBrains HTTP Client

## Development Workflow

### Common Commands for AI development

- `bun run build`: Build the application to check building the app works.
- `bun run:server`: Run the server to check app works (use timeout command to make it stop after 10 s).
- `bun check`: Run type checking and linting.
- `docker build -t halloffameserver . --progress=plain`: Check that the Docker build works.

### Environment Variables

- Configure database connection in `.env` or `.env.local` (for local overrides).
- Default development connection string can be found in `.env`.
- Make environment variables available to code through `projects/server/config.ts`.

## Best Practices

- **Code Style**: Use Biome for formatting and linting.
- **Commit Messages**: Follow Conventional Commits specification.
- **Database Schema**: Update schema in `prisma/schema.prisma` and run `bun prisma db push`.
- **API Development**: Follow RESTful principles and use NestJS decorators.
- **Error Handling**: Use exception filters and Sentry for error tracking.
- **Authentication**: Use the CreatorAuthorizationGuard for protected endpoints.
- **Validation**: Use ZodParsePipe for request validation.
