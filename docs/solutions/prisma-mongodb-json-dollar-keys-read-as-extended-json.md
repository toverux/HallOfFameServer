---
date: 2026-10-28
area: prisma
symptoms:
  - "Inconsistent column data: Failed to convert 'Stringified JSON' to 'Mongo BSON (extJSON)'"
  - 'a Json field read back as an ObjectId, a Date or a number instead of an object'
tags: [prisma, mongodb, json, extended-json, validation, client-input]
---

# Prisma on MongoDB reads `$`-prefixed keys in a Json field as Extended JSON

## Problem

A client-supplied object stored in a `Json` field changes type or fails the insert when one of its keys is an Extended JSON operator: no validation error, a 500 or a silently retyped document.

## Root cause

Prisma's MongoDB connector (6.19) converts a `Json` value to BSON through Extended JSON, at any depth.
A lone operator key is taken as the typed value it encodes: `{ "$oid": "507f…" }` is stored as an ObjectId, `{ "$date": … }` as a Date, `{ "$numberLong": "5" }` as a number.
An operator key beside another key fails the conversion with `P2023`, losing the whole write.
A `$` key that is no operator, such as `$foo`, is stored as is.

## Fix

Reject `$`-prefixed keys where the input is validated, before it reaches Prisma.
The upload's JSON fields do it at every depth with a `JSON.parse` reviver (`projects/server/rest/controllers/screenshot.controller.ts:909`); the usage events endpoint, whose keys must also be addressable by an aggregation's field path, allows plain field names only (`projects/server/rest/controllers/usage.controller.ts:73`).
Dotted keys are stored as is, and the mod sends them in `renderConditions` (`time.hour`).

## Prevention

A validator for a client object bound for a `Json` field has a test rejecting a `$`-prefixed key, nested where the object nests.
