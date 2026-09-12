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

Draining the work in `onModuleDestroy`: every service lives in `SharedModule`, and Nest calls one module's hooks in parallel, so the drain would race `PrismaService`'s disconnect.

## Root cause

`close()` (`node_modules/@nestjs/core/nest-application-context.js:126`) runs every `onModuleDestroy`, one module's providers under `Promise.all` (`hooks/on-module-destroy.hook.js:43`), then `beforeApplicationShutdown`, then `dispose()`, which closes the HTTP server, then `onApplicationShutdown`.
`PrismaService` disconnected in `onModuleDestroy`, the first phase.

## Fix

`BackgroundTasksService` drains in `beforeApplicationShutdown` (`background-tasks.service.ts:41`); `PrismaService` disconnects and the similarity detector terminates its worker in `onApplicationShutdown` (`prisma.service.ts:80`, `screenshot-similarity-detector.service.ts:110`).

## Prevention

Start fire-and-forget work through `BackgroundTasksService.run()`, and release a resource that tasks use in `onApplicationShutdown`.
