---
date: 2026-10-17
area: bun.lock
symptoms:
  - "SyntaxError: The requested module '@jridgewell/sourcemap-codec' does not provide an export named 'encodeRangeMappings'"
tags: [bun, lockfile, dependencies, angular]
---

# bun.lock keeps a stale transitive version a new dependent needs newer

## Problem

After bumping `@angular/compiler-cli` to 22.2.3, `ng build` failed on a missing export: the hoisted `@jridgewell/sourcemap-codec` stayed at 1.5.5, while the compiler imports an API added in 1.6.0.

## What didn't work

Deleting the stale entry from `bun.lock` and running `bun install`: Bun re-resolved a large part of the tree, moving unrelated transitive packages and an unreviewed direct dependency within its range.

## Root cause

The dependent declares a range looser than what it imports (`^1.4.14`), and the locked 1.5.5 satisfies it, so `bun install` and `bun add` keep it.

## Fix

Edit the root entry in place to the needed version and its integrity hash (from `bun pm view <pkg>@<version> dist.integrity`, or from a scratch install), then `bun install --frozen-lockfile` to check it.
A fresh resolve picks the same highest version, so this is no workaround to track.

## Prevention

When a bump fails on a missing export from a transitive package, compare the lock entry against the latest version in the declared range before suspecting the code.
