---
date: 2026-10-15
area: prisma
symptoms:
  - 'Inconsistent column data: Malformed ObjectID: provided hex string representation must be exactly 12 bytes'
tags: [prisma, mongodb, objectid, filters, lookup-by-name]
---

# Prisma on MongoDB throws on a filter comparing an ObjectId field to a non-ObjectId string

## Problem

A lookup accepting an ID or a name, `where: { OR: [{ id: arg }, { creatorName: arg }] }`, throws for every name instead of matching it by name: the whole query fails, not just the `id` branch.

## Root cause

Prisma's MongoDB connector (6.19) converts a string compared to an `@db.ObjectId` field before running the query, and a string that is not a valid ObjectId fails that conversion with a `PrismaClientKnownRequestError`, wherever the comparison sits in the filter, `OR` branches included.

## Fix

Test the string with `ObjectId.isValid()` from `mongodb` and build the `id` comparison only when it passes, as `fetchCreatorById()` does (`projects/server/rest/controllers/creator.controller.ts:212`):

```ts
where: ObjectId.isValid(id)
  ? { id }
  : { OR: [{ creatorName: { equals: id, mode: 'insensitive' } }, { creatorNameSlug: id }] };
```

## Prevention

A test of a lookup by ID or name passes a name.
