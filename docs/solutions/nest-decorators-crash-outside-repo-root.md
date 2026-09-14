---
date: 2026-09-14
area: projects/server
symptoms:
  - "TypeError: undefined is not an object (evaluating 'target.constructor')"
tags: [bun, nestjs, decorators, tsconfig, scripts]
---

# Nest decorators crash in a script run outside the repo root

## Problem

A throwaway script importing a server service, run with `bun -e` from another directory (`/tmp`), crashes on the service's `@Inject` before any of its code runs.

## What didn't work

Switching the Bun version: 1.3.14 and 1.4.0 both crash outside the repo, and both work from its root.

## Root cause

Outside the repo, Bun compiles the service without the root `tsconfig.json`'s `experimentalDecorators`, so its property decorators run as standard decorators, which pass no target: `node_modules/@nestjs/common/decorators/core/inject.decorator.js:49` then reads `target.constructor` on `undefined`.

## Fix

Run the script from the repo root, keeping scratch files elsewhere if needed: `mise exec -- bun /tmp/script.ts`, or `mise exec -- bun -e '…'` with the repo as the working directory.
