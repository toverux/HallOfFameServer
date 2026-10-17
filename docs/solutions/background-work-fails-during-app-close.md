---
date: 2026-09-12
area: projects/server/services
symptoms:
  - 'Failed to warmup mods cache for screenshot … PrismaClientUnknownRequestError … Response from the Engine was empty'
tags: [nestjs, lifecycle, shutdown, prisma, background-tasks]
---

# Background work fails during app close

## Problem

Fire-and-forget work still running at `app.close()` (a test's `afterEach`, the CLI exiting) failed on a disconnected Prisma client, logging errors after the test that started it had passed.

## What didn't work

Draining the work in `onModuleDestroy`: Nest orders one module's hooks only by provider dependency, dependents first, and runs a level's hooks in parallel. `BackgroundTasksService` does not depend on `PrismaService`, yet its tasks use it, so the drain is not ordered before the disconnect.

## Root cause

`close()` runs every `onModuleDestroy`, one module's providers grouped by dependency level (`hooks/on-module-destroy.hook.js`), then `beforeApplicationShutdown`, then `dispose()`, which closes the HTTP server, then `onApplicationShutdown`.
`PrismaService` disconnected in `onModuleDestroy`, the first phase.

## Fix

`BackgroundTasksService` drains in `beforeApplicationShutdown` (`background-tasks.service.ts:41`); `PrismaService` disconnects and the similarity detector terminates its worker in `onApplicationShutdown` (`prisma.service.ts:80`, `screenshot-similarity-detector.service.ts:110`).

## Prevention

Start fire-and-forget work through `BackgroundTasksService.run()`, and release a resource that tasks use in `onApplicationShutdown`.
