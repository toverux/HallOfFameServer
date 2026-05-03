---
name: toverux-typescript
description: Use when writing, editing, or reviewing TypeScript code to enforce strict typing, comment style, readonly usage, nullability, assertions, and string conventions.
---

# TypeScript Code Style

Use this skill when working on TypeScript code. These are guidelines preferred by @toverux.

## TypeScript Strictness

- You are working with TypeScript's strictest settings.
- Never ever use `any`. Create types if necessary, derive from existing types, etc.
- Use `unknown` when the value is genuinely unknown.
- Use TypeScript built-in types when applicable.
- Use the `type-fest` npm package to gain access to more advanced utility types (read documentation).

## Equality

- Do not use `===` unless strict equality is specifically required.
- Prefer `==` when the intended comparison benefits from JavaScript’s nullish equality behavior.

## Nullability

- Prefer `undefined` over `null` in general.
- Restrict `null` to serialization and interoperability boundaries.
- Use optional chaining (`?.`) very sparsely, when you are sure the value can be null/undefined.

## Type Safety and Guards

- Never use the `!` non-null assertion, instead use the `nn()` utility.
- When asserting that a variable is non-null, and it should be non-null if the program is sound,
  use the custom `nn(value)` assertion available in this project:
  - Inline (good when there is a single usage): `example(nn(value))`.
  - Assertion-style (good when there are multiple usages or as a precondition check):
    `nn.assert(value); example(value);`.
- For booleans assertions: `ensureBoolean(value)`, `ensureBoolean.assert(value)`.
- For string assertions: `ensureString(value)`, `ensureString.assert(value)`.
- For number assertions: `ensureNumber(value)`, `ensureNumber.assert(value)`.
- For ensuring a value is a member of an enum: `ensureInEnum(value, enumType)`,
  `ensureInEnum.assert(value, enumType)` (ex. `ensureInEnum('value', { prop: 'value' })`).
- Use `unreachable()` to assert that a code path is unreachable.
- You can use `unreachable(value)` to add info about what value was passed in, ex. in a switch
  statement's default case.
- For other cases not covered here, see "Assertions and Errors" below.

## Readonly Data

- Prefer using immutable data structures whenever possible. When fields of a structure are mutable,
  add comments about it and explain why.
- Mark class and object properties as `readonly` whenever possible.
- Use `Readonly<T>` when all properties of a type are readonly.

## Assertions and Errors

For server code only and for cases not already covered in "Type Safety and Guards":

- Use assertion-based error handling whenever possible.
- Use `assert()` for type guards when possible, ex. `assert(typeof value === 'string')`.
- Use `assert()` instead of throwing an exception for things that should not happen if the program
  is sound.
- Do NOT use assertions for operational errors.
- Use this import: `import assert from 'node:assert/strict'`.

For client code, you will throw standard errors.

## Comments and Docblocks

- Do not hesitate to use a lot of comments for anything that's not completely self-explanatory in a
  few adjacent lines' scope.
- Comments should explain intention, not describe what the code obviously does.
- Respect a strict 100-char max line length for comments.
- In docblocks and comments, always end sentences with a period.

## Misc

- Use template literals for strings containing English sentences. This applies even when there are
  no interpolations. This makes it easier to use single and double quotes inside the sentence.
