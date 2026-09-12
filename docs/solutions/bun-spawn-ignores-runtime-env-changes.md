---
date: 2026-09-12
area: projects/server/testing
symptoms:
  - 'child process sees the launch-time value of a variable the parent changed in process.env'
tags: [bun, spawn, environment, preload]
---

# Bun.spawn ignores runtime changes to process.env

## Problem

A variable set on `process.env` at runtime, as the test environment preload does, does not reach a process started with `Bun.spawn` or `Bun.spawnSync`: the child sees the value the parent launched with.

## Root cause

Bun's spawn APIs default `env` to the environment captured at process start, not the live `process.env` object.

## Fix

Pass the environment explicitly, as `projects/server/testing/preload-database.ts` does for `prisma db push`:

```ts
Bun.spawn({ cmd: ['bun', 'prisma', 'db', 'push', '--skip-generate'], env: process.env });
```

## Prevention

Any spawn after an environment change passes `env: process.env`.
