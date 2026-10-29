---
date: 2026-10-29
area: screenshot-similarity-detector
symptoms:
  - 'Expected value to be not null or undefined, found (undefined) undefined.'
  - 'Failed to infer embeddings or open near-duplicate cases for screenshot'
tags: [usearch, similarity, embeddings, cli, in-memory-index]
---

# The server's similarity index keeps the keys of embeddings a CLI run deleted

## Problem

After a CLI merge or delete, a similar upload's background task threw in `findSimilarScreenshots`, and the upload got no near-duplicate case at all.

## Root cause

The server builds the USearch index once per process (`usearchIndex`, `screenshot-similarity-detector.service.ts:63`) and keeps it until it restarts.
A CLI run deletes `ScreenshotFeatureEmbedding` documents in its own process and removes their keys only from its own index (`if (this.wasUsearchIndexRequired)`), so the server's index still returns those keys, and `nn()` on the missing document threw.

## Fix

`findSimilarScreenshots` skips a key whose embedding document is gone, as `findPotentialDuplicates` already did.

## Prevention

Any new reader of the index tolerates a key with no embedding document; the detector test `skips an index match whose embedding was deleted meanwhile` covers the search.
