---
date: 2026-11-07
area: server/dashboards
symptoms:
  - 'a per-session $group over usage events and server rows takes many seconds at volume'
tags: [mongodb, aggregation, group, unionwith, performance, metabase, dashboards]
---

# A `$group` spills to disk when its key or its state grows per document

## Problem

The Feature usage cards group usage events, screenshots, views and likes by session. On a copy seeded at volume (309k sessions, 2.27M views), the first pipelines spilled their groups to disk and ran several times slower.

## What didn't work

- Grouping by a compound key (`{ sessionId, name }`) to count each name per session: 11 s against 1.5 s for the same group keyed by session alone, as the group holds one entry per pair.
- Counting each name with a `$sum` accumulator per name in the session group: the per-session state grew with the names and spilled.

## Root cause

A `$group` holds every key and its accumulators in memory up to its limit, then spills to disk. Each extra key component or accumulator multiplies that state across hundreds of thousands of sessions.

## Fix

`sessionStages` in `projects/server/dashboards/feature-usage/sessions.ts`:

- Group each source by session alone before the union. Events `$push` only the counted names (`$cond` with `$$REMOVE`), then a `$project` counts each with `$size` of a `$filter`.
- Union only the server rows a card counts, each pre-grouped to `{ _id: session, [name]: count }`.
- Merge the sources with `$max` per name, since each source alone holds its counts.

## Prevention

Key a group by one field over the largest set, and keep its accumulators few; count per name after the group, in a `$project`.
