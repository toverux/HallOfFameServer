---
description: Guide for using type-fest, the essential TypeScript utility types library by Sindre Sorhus (~84M weekly npm downloads). Use this skill whenever the user is working with TypeScript types and needs help with type transformations, deep object manipulation, string template types, JSON types, type guards, branded/tagged types, or asks about type-fest specifically. Also trigger when the user wants to make types readonly/writable deeply, merge object types, do case conversion at the type level, work with union/intersection transformations, validate forms with type constraints, normalize API responses, or needs stricter versions of built-in TypeScript utilities. If the user is writing complex TypeScript types by hand that type-fest already provides, suggest using type-fest instead.
metadata:
    github-path: skills/type-fest
    github-ref: refs/heads/main
    github-repo: https://github.com/pradeepmouli/skills
    github-tree-sha: b911af6eaec5331b3dae0c7dfd99fc8df95506ba
name: type-fest
---
# type-fest

A collection of essential TypeScript types by [Sindre Sorhus](https://github.com/sindresorhus/type-fest).

## Setup

- **Install:** `npm install type-fest`
- **Requires:** TypeScript >= 5.9, ESM, `{ "strict": true }` in tsconfig
- **Import:** Always use `import type` — zero runtime cost

```ts
import type {Merge, PartialDeep, Tagged} from 'type-fest';
```

## Use Case Router

Identify what the user needs and read the relevant reference file for detailed types, examples, and patterns.

### Validation & Constraints
Need to enforce shape rules — require certain keys, make fields exclusive, constrain values?
-> Read `references/validation.md`

Key types: `RequireAtLeastOne`, `RequireExactlyOne`, `RequireAllOrNone`, `MergeExclusive`, `Tagged`, `IntRange`, `NonEmptyTuple`, `NonEmptyString`, `SetNonNullable`

### Transformation
Need to reshape, convert, merge, or deeply modify object types?
-> Read `references/transformation.md`

Key types: `Merge`, `MergeDeep`, `PartialDeep`, `ReadonlyDeep`, `WritableDeep`, `Except`, `SetOptional`, `SetRequired`, `Simplify`, `Spread`, `CamelCasedPropertiesDeep`, `Jsonify`

### Inspection & Guards
Need to query types, check properties, or do conditional type logic?
-> Read `references/inspection.md`

Key types: `IsEqual`, `IsAny`, `IsNever`, `IsLiteral`, `If`, `ConditionalKeys`, `ConditionalPick`, `OptionalKeysOf`, `RequiredKeysOf`, `Paths`, `Get`, `KeysOfUnion`

### Collections
Need array, tuple, numeric, string, or union/intersection utilities?
-> Read `references/collections.md`

Key types: `ArrayElement`, `FixedLengthArray`, `TupleToUnion`, `UnionToIntersection`, `Split`, `Join`, `CamelCase`, `SnakeCase`, `IntRange`, `Sum`, `JsonValue`

## Quick Decision Guide

| "I need to..." | Start with |
|---|---|
| Enforce form rules (at least one field, exactly one, etc.) | `references/validation.md` |
| Prevent mixing IDs/tokens (branded types) | `references/validation.md` |
| Constrain numeric ranges | `references/validation.md` |
| Merge configs or object types | `references/transformation.md` |
| Make types deeply optional/readonly/mutable | `references/transformation.md` |
| Normalize API response key casing | `references/transformation.md` |
| Serialize to JSON-safe types | `references/transformation.md` |
| Strip or pick keys conditionally | `references/inspection.md` |
| Check type properties at compile time | `references/inspection.md` |
| Access deeply nested type paths | `references/inspection.md` |
| Work with arrays, tuples, strings, numbers | `references/collections.md` |
| Transform unions or convert case | `references/collections.md` |

## Full Type Catalog

For a comprehensive list of all ~150+ types: `references/types-catalog.md`
