---
date: 2026-10-15
area: server/dashboards
symptoms:
  - 'a cohort pipeline with several $lookup stages takes seconds even when the lookups match nothing'
tags: [mongodb, aggregation, lookup, performance, metabase, dashboards]
---

# A correlated `$lookup` costs per input document, not per match

## Problem

The Newcomers dashboard's Retention card took about 12 s on the dev copy (15.6k creators, 2.2M views): each creator ran six `$lookup` sub-pipelines, two per retention window.

## What didn't work

- Folding `creator_activities` into the `views` lookup with `$unionWith`, for one lookup per creator: slower than separate lookups.
- Merging the three windows into one lookup per collection (days 1 to 37) and flagging each window in a `$group`: 8.5 s, as each lookup now scans more records per creator.

## Root cause

A correlated `$lookup` starts its sub-pipeline once per input document, and that start dominates.
A limit-1 lookup into the empty `creator_activities` collection still cost about 2.4 s over 15.6k creators, while `explain('executionStats')` showed the `views` lookups using the `creatorId` index, with keys examined equal to hits.

## Fix

Cut lookups per card, not data per lookup: one card per window (`retention.ts`, a split Metabase's one-metric breakout charts need anyway), each running two `$limit: 1` lookups, one per collection, about 1.7 s per card.

## Prevention

Count a pipeline's lookups times its input documents before tuning a sub-pipeline's match.
