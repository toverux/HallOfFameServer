---
date: 2026-10-14
area: prisma
symptoms:
  - 'a P2002 retry around a concurrent upsert never runs'
tags: [prisma, mongodb, upsert, p2002, unique-index, concurrency, transactions]
---

# Prisma on MongoDB never raises P2002 from a concurrent upsert

## Problem

A once-retry on `P2002` around a Prisma `upsert`, meant for two concurrent first inserts on one unique key, is dead code: the error never reaches it.

## Root cause

Prisma's MongoDB connector (6.19) has no native upsert.
It emulates one inside a transaction: an `aggregate` lookup, then an `insertOne` or an `updateMany`, then an `aggregate` read-back, which `select` trims but never skips.
Concurrent upserts on one key surface as transient write conflicts that the engine retries itself: 1,500 concurrent upserts on 30 keys against the dev MongoDB raised no error and left one record per key.

A plain `create` runs outside such a transaction, so a `P2002` retry around one, as in `CreatorService.authenticateCreatorForMod`, stays valid.

## Fix

Drop the retry, and pin the outcome with a test of concurrent requests ending on one record (`creator.controller.test.ts`, "records concurrent calls on a single record").
