---
date: 2026-10-05
area: prisma
symptoms:
  - 'a where clause on null skips documents created before the field existed'
tags: [prisma, mongodb, null, optional-fields, composite-types, scalar-lists, filters, migrations]
updated: 2026-10-09
---

# Prisma on MongoDB tells a null field from an absent one

## Problem

A new optional field is absent, not null, on documents written before it existed.
A Prisma filter meant to match "no value" then silently skips those documents, and nothing errors.

## Root cause

Unlike a raw MongoDB query, Prisma's MongoDB connector (6.19) matches `{ field: null }` only against a stored null, and `{ field: { notIn: [...] } }` matches a stored null but skips an absent field.

Reads are safer: an absent scalar list reads as `[]`, so a new required `String[]` field needs no backfill migration, while its filters still need the care below.

## Fix

Match both forms, as the mod sync cron does for `state` (`projects/server/services/mod.service.ts:274`):

```ts
OR: [{ state: { isSet: false } }, { state: null }, { state: 'published' }];
```

On an optional composite, `{ field: { isSet: true } }` matches a stored null and a stored value but not an absent field, as the Skyve sync's unset does (`projects/server/services/skyve.service.ts:159`).

## Prevention

A test of a filter over an optional field seeds the field both absent, as the factories do by omitting it, and explicitly null.
