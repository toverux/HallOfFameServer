---
date: 2026-09-12
area: projects/server/testing
symptoms:
  - 'Client must be connected before running operations'
  - "TypeError: undefined is not an object (evaluating 'testingModule.close')"
tags: [bun, testing, rerun-each, preload, mongodb, flakiness]
---

# `bun test --rerun-each` breaks the test database preload

## Problem

Rerunning a test file with `--rerun-each` to check it for flakiness passes the first round, then fails every later one on a closed MongoDB client.

## Root cause

The preload's `afterAll` drops the run's database and closes its client (`projects/server/testing/preload-database.ts:44`) once the first round ends; later rounds' `beforeEach` then empties collections through the closed client (`preload-database.ts:40`).

## Fix

Rerun in separate processes, each with its own database:

```sh
for i in 1 2 3 4; do bun test path/to/file.test.ts; done
```

## Prevention

Check flakiness with separate `bun test` runs rather than `--rerun-each`.
