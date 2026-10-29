---
date: 2026-10-29
area: prisma
symptoms:
  - 'P2034: Transaction failed due to a write conflict or a deadlock. Please retry your transaction'
tags: [prisma, mongodb, transactions, p2034, write-conflict, concurrency]
---

# Prisma on MongoDB fails a concurrent interactive transaction with P2034

## Problem

Moving an update of a hot document into an interactive `prisma.$transaction(async tx => …)` makes concurrent writes of that document fail: one transaction commits, the others throw `P2034`, and their requests answer 500.
The same updates outside a transaction all succeed.

## Root cause

MongoDB aborts a transaction whose write conflicts with another's, and Prisma's MongoDB connector (6.19) surfaces the abort of an interactive transaction as `P2034` without retrying it.
The transactions Prisma runs on its own, as for an emulated upsert, are retried by the engine ([prisma-mongodb-upsert-never-raises-p2002.md](prisma-mongodb-upsert-never-raises-p2002.md)); a transaction the code opens is not.
Six concurrent reports of one screenshot through `ScreenshotService.markReported` (`projects/server/services/screenshot.service.ts`), whose flag update shares a transaction with opening a moderation case, answered one 201 and five 500s.

## Fix

Retry the transaction on `P2034`, or keep the contended write outside it.
`markReported` keeps the failure on purpose: two reports of one screenshot within milliseconds are rare, and the reporter can report again.

## Prevention

Before wrapping a write to a document many requests touch in an interactive transaction, test concurrent requests on that document.
