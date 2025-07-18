- Use the strictest TypeScript settings.
- In docblocks and comments, always end sentences with a period.
- In comments, explain the intention, not what the code does. Avoid obvious comments.
- Never use `any`, prefer using real types or `unknown` where applicable.
- Mark class or object properties as readonly whenever possible.
  Use `Readonly<T>` for types if all properties of the type are readonly.
- Use TypeScript built-in types when applicable.
- Prefer using undefined over null in general, null should be restricted to serialization and interoperability only.
- Do not use triple equals `===` unless you really need it.
- For server code, use `assert()` instead of throwing an exception for things that should not happen (not operational errors).
  Use: `import assert from 'node:assert/strict';`.
  When you have to assert that a variable is non-null and shouldn't be null if the program is sound, just do `assert(myVar)`;
- Use template literals for strings containing English sentences (ex. throwing an exception), even if there are no interpolations.
  This makes it easier to use single and double quotes.
