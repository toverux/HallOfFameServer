# Dependency updates

Upgrades skipped and workarounds kept for a dependency's bug, one entry per package.
Before upgrading a package, read its entry: honor a live one, and lift one whose blocking condition the new release resolves.

## bun

- **Workaround**: tests assert `Date` values with `toEqual`, never with `toMatchObject`, which passes on any two Dates in `bun:test`, nested or top-level ([oven-sh/bun#44405](https://github.com/oven-sh/bun/issues/44405)).
- **Reason**: the subset matcher walks only the expected object's enumerable keys, and a `Date` has none, so it compares nothing; `toEqual`, `toStrictEqual`, `objectContaining`, `arrayContaining`, `toHaveProperty` and `toContainEqual` compare Dates correctly.
- **Blocked until**: a Bun release fixes #44405 (fix proposed in [oven-sh/bun#44497](https://github.com/oven-sh/bun/pull/44497)).
  Then remove the `Date` line from the Assertions section of `.agents/skills/hof-server-testing/SKILL.md`, and in these tests restore `toMatchObject` where a Date was split out of it or narrowed by a Prisma `select`, dropping the comments naming the bug:
  - `projects/server/rest/controllers/creator.controller.test.ts`, the activity record tests;
  - `projects/server/rest/controllers/screenshot.controller.test.ts`, `stores a screenshot uploaded as the mod sends it`;
  - `projects/server/services/mod.service.test.ts`, the `syncModDetailsCron()` and `resyncAll()` tests;
  - `projects/server/services/screenshot-merging.service.test.ts`, `keeps one like per $shared, dated from the earliest`;
  - `projects/server/cli/commands/creator/creator-merge.command.test.ts`, `findCreatedAt`.
- **Date**: 2026-10-15
