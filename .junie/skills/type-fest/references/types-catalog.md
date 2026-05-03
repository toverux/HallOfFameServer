# type-fest Complete Type Catalog

## Table of Contents
- [Basic/Primitive Types](#basicprimitive-types)
- [Object Manipulation](#object-manipulation)
- [Deep Utilities](#deep-utilities)
- [Key Inspection](#key-inspection)
- [Conditional Filtering](#conditional-filtering)
- [Union/Intersection Transforms](#unionintersection-transforms)
- [JSON Types](#json-types)
- [Structured Clone](#structured-clone)
- [Async Types](#async-types)
- [String Types](#string-types)
- [Case Conversion](#case-conversion)
- [Array/Tuple Types](#arraytuple-types)
- [Numeric Types](#numeric-types)
- [Type Guards](#type-guards)
- [Function Types](#function-types)
- [Tagged/Branded Types](#taggedbranded-types)
- [Stricter Built-ins](#stricter-built-ins)
- [Miscellaneous](#miscellaneous)

---

## Basic/Primitive Types

| Type | Description |
|------|-------------|
| `Primitive` | Matches any primitive value (`string`, `number`, `boolean`, `bigint`, `symbol`, `undefined`, `null`) |
| `Class<T>` | Matches a class (constructor that returns T) |
| `Constructor<T>` | Matches a class constructor |
| `AbstractClass<T>` | Matches an abstract class |
| `AbstractConstructor<T>` | Matches an abstract class constructor |
| `TypedArray` | Matches any typed array (Uint8Array, Float32Array, etc.) |
| `ObservableLike` | Matches Observable-like values |
| `LowercaseLetter` | Union of `'a' \| 'b' \| ... \| 'z'` |
| `UppercaseLetter` | Union of `'A' \| 'B' \| ... \| 'Z'` |
| `DigitCharacter` | Union of `'0' \| '1' \| ... \| '9'` (as strings) |
| `Alphanumeric` | Union of letters and digits |

## Object Manipulation

| Type | Description |
|------|-------------|
| `Except<T, K>` | Create type without specified keys (like `Omit` but stricter) |
| `Merge<A, B>` | Merge two types, B's keys override A's |
| `ObjectMerge<A, B>` | Merge specifically for object types |
| `MergeExclusive<A, B>` | Create type where A and B keys are mutually exclusive |
| `OverrideProperties<T, U>` | Override existing properties with new types |
| `SetOptional<T, K>` | Make specified keys optional |
| `SetRequired<T, K>` | Make specified keys required |
| `SetReadonly<T, K>` | Make specified keys readonly |
| `SetNonNullable<T, K>` | Remove null/undefined from specified keys |
| `SetFieldType<T, K, V>` | Change the type of specified keys |
| `Writable<T>` | Remove readonly from all keys (shallow) |
| `Simplify<T>` | Flatten intersection/mapped types for better IDE display |
| `Exact<T, Shape>` | Disallow extra properties beyond Shape |
| `Spread<A, B>` | Type-level spread: `{...a, ...b}` |
| `EmptyObject` | Represents `{}` that truly has no properties |
| `NonEmptyObject<T>` | Object with at least one non-optional key |
| `UnknownRecord` | `Record<string, unknown>` |
| `SingleKeyObject<T>` | Only accepts objects with exactly one key |
| `OmitIndexSignature<T>` | Remove index signatures, keep explicit keys |
| `PickIndexSignature<T>` | Keep only index signatures |

## Deep Utilities

| Type | Description |
|------|-------------|
| `PartialDeep<T>` | Recursively make all properties optional |
| `RequiredDeep<T>` | Recursively make all properties required |
| `ReadonlyDeep<T>` | Recursively make all properties readonly |
| `WritableDeep<T>` | Recursively remove readonly |
| `MergeDeep<A, B>` | Recursively merge two types |
| `PickDeep<T, Path>` | Pick deeply nested properties by path |
| `OmitDeep<T, Path>` | Omit deeply nested properties by path |
| `SetRequiredDeep<T, K>` | Deeply make selected keys required |
| `SetNonNullableDeep<T, K>` | Deeply remove null/undefined from selected keys |
| `PartialOnUndefinedDeep<T>` | Make optional where undefined is already accepted |
| `UndefinedOnPartialDeep<T>` | Accept undefined on already-optional keys |
| `SimplifyDeep<T>` | Recursively simplify/flatten types |
| `LiteralToPrimitiveDeep<T>` | Recursively widen literal types to primitives |
| `Schema<T, V>` | Deep version of a type with all values replaced by V |

## Key Inspection

| Type | Description |
|------|-------------|
| `OptionalKeysOf<T>` | Extract keys that are optional |
| `RequiredKeysOf<T>` | Extract keys that are required |
| `ReadonlyKeysOf<T>` | Extract keys that are readonly |
| `WritableKeysOf<T>` | Extract keys that are writable |
| `HasOptionalKeys<T>` | Boolean: does T have optional keys? |
| `HasRequiredKeys<T>` | Boolean: does T have required keys? |
| `HasReadonlyKeys<T>` | Boolean: does T have readonly keys? |
| `HasWritableKeys<T>` | Boolean: does T have writable keys? |
| `KeysOfUnion<T>` | All keys across all union members |
| `KeyAsString<T>` | Get keys as string type |
| `ValueOf<T>` | Union of all value types |

## Conditional Filtering

| Type | Description |
|------|-------------|
| `ConditionalKeys<T, Condition>` | Keys whose values extend Condition |
| `ConditionalPick<T, Condition>` | Pick properties whose values extend Condition |
| `ConditionalPickDeep<T, Condition>` | Deeply pick by value type |
| `ConditionalExcept<T, Condition>` | Exclude properties whose values extend Condition |
| `ConditionalSimplify<T>` | Simplify with conditions |
| `ConditionalSimplifyDeep<T>` | Recursively simplify with conditions |

## Union/Intersection Transforms

| Type | Description |
|------|-------------|
| `UnionToIntersection<U>` | Convert union `A \| B` to intersection `A & B` |
| `SharedUnionFields<U>` | Fields present in all union members |
| `SharedUnionFieldsDeep<U>` | Deeply shared fields from union |
| `AllUnionFields<U>` | All fields from any union member |
| `DistributedOmit<U, K>` | Apply Omit to each union member individually |
| `DistributedPick<U, K>` | Apply Pick to each union member individually |
| `ExclusifyUnion<U>` | Make union members mutually exclusive |
| `TaggedUnion<Tag, Members>` | Create discriminated union |
| `LiteralUnion<Literal, Base>` | Union of literals with base type (preserves autocomplete) |

## JSON Types

| Type | Description |
|------|-------------|
| `JsonValue` | Any valid JSON value |
| `JsonPrimitive` | `string \| number \| boolean \| null` |
| `JsonObject` | `{[key: string]: JsonValue}` |
| `JsonArray` | `JsonValue[]` |
| `Jsonify<T>` | Transform type to its JSON-serialized form |
| `Jsonifiable` | Values that can be losslessly converted to JSON |

## Structured Clone

| Type | Description |
|------|-------------|
| `StructuredCloneable` | Values compatible with `structuredClone()` |

## Async Types

| Type | Description |
|------|-------------|
| `Promisable<T>` | `T \| PromiseLike<T>` |
| `AsyncReturnType<F>` | Unwrap Promise from async function return |
| `Asyncify<F>` | Make function return a Promise |

## String Types

| Type | Description |
|------|-------------|
| `Trim<S>` | Remove leading/trailing whitespace |
| `Split<S, Delimiter>` | Split string into tuple |
| `Words<S>` | Split string into words |
| `Replace<S, From, To>` | Replace substring |
| `StringSlice<S, Start, End>` | Slice of string |
| `StringRepeat<S, N>` | Repeat string N times |
| `RemovePrefix<S, Prefix>` | Remove string prefix |
| `Join<A, Delimiter>` | Join tuple into string |
| `NonEmptyString` | String that isn't `''` |

## Case Conversion

| Type | Description |
|------|-------------|
| `CamelCase<S>` | `'foo-bar'` -> `'fooBar'` |
| `PascalCase<S>` | `'foo-bar'` -> `'FooBar'` |
| `KebabCase<S>` | `'fooBar'` -> `'foo-bar'` |
| `SnakeCase<S>` | `'fooBar'` -> `'foo_bar'` |
| `ScreamingSnakeCase<S>` | `'fooBar'` -> `'FOO_BAR'` |
| `DelimiterCase<S, D>` | Convert to custom delimiter |
| `CamelCasedProperties<T>` | Convert all property names to camelCase |
| `CamelCasedPropertiesDeep<T>` | Recursively convert property names |
| `PascalCasedProperties<T>` | Convert all property names to PascalCase |
| `PascalCasedPropertiesDeep<T>` | Recursively convert property names |
| `KebabCasedProperties<T>` | Convert all property names to kebab-case |
| `KebabCasedPropertiesDeep<T>` | Recursively convert property names |
| `SnakeCasedProperties<T>` | Convert all property names to snake_case |
| `SnakeCasedPropertiesDeep<T>` | Recursively convert property names |
| `DelimiterCasedProperties<T, D>` | Convert property names to custom delimiter |
| `DelimiterCasedPropertiesDeep<T, D>` | Recursively convert property names |

## Array/Tuple Types

| Type | Description |
|------|-------------|
| `ArrayElement<A>` | Extract element type from array |
| `LastArrayElement<A>` | Type of last element |
| `FixedLengthArray<T, N>` | Array with exactly N elements |
| `MultidimensionalArray<T, Dims>` | Multi-dimensional array |
| `MultidimensionalReadonlyArray<T, Dims>` | Readonly multi-dimensional array |
| `ReadonlyTuple<T>` | Readonly tuple type |
| `NonEmptyTuple` | Tuple with at least one element |
| `TupleToUnion<T>` | `[A, B, C]` -> `A \| B \| C` |
| `UnionToTuple<U>` | `A \| B \| C` -> `[A, B, C]` |
| `TupleToObject<T>` | Transform tuple to object |
| `TupleOf<T, N>` | Tuple of T with length N |
| `ArraySlice<A, Start, End>` | Slice of array type |
| `ArraySplice<A, Start, Count, Insert>` | Splice array type |
| `ArrayTail<A>` | Array without first element |
| `ArrayReverse<A>` | Reverse tuple order |
| `ArrayLength<A>` | Length of tuple type |
| `SplitOnRestElement<T>` | Split tuple on rest element |
| `ExtractRestElement<T>` | Extract rest element type |
| `ExcludeRestElement<T>` | Remove rest element |
| `Arrayable<T>` | `T \| T[]` |
| `Includes<A, T>` | Check if array includes type |

## Numeric Types

| Type | Description |
|------|-------------|
| `IntRange<Start, End>` | Union of integers (excludes end) |
| `IntClosedRange<Start, End>` | Union of integers (includes end) |
| `Integer<T>` | Constrain to integer |
| `Float<T>` | Constrain to non-integer |
| `Finite<T>` | Constrain to finite number |
| `Negative<T>` | Constrain to negative |
| `NonNegative<T>` | Constrain to >= 0 |
| `NegativeInteger<T>` | Constrain to negative integer |
| `NonNegativeInteger<T>` | Constrain to >= 0 integer |
| `NegativeFloat<T>` | Constrain to negative float |
| `PositiveInfinity` | The `Infinity` type |
| `NegativeInfinity` | The `-Infinity` type |
| `IsNegative<T>` | Boolean check |
| `IsFloat<T>` | Boolean check |
| `IsInteger<T>` | Boolean check |
| `GreaterThan<A, B>` | Boolean: A > B |
| `GreaterThanOrEqual<A, B>` | Boolean: A >= B |
| `LessThan<A, B>` | Boolean: A < B |
| `LessThanOrEqual<A, B>` | Boolean: A <= B |
| `Sum<A, B>` | Add two numeric types |
| `Subtract<A, B>` | Subtract two numeric types |

## Type Guards

| Type | Description |
|------|-------------|
| `If<Cond, Then, Else>` | Conditional type resolution |
| `IsEqual<A, B>` | Check exact type equality |
| `IsLiteral<T>` | Check if literal type |
| `IsStringLiteral<T>` | Check for string literal |
| `IsNumericLiteral<T>` | Check for number/bigint literal |
| `IsBooleanLiteral<T>` | Check for `true`/`false` literal |
| `IsSymbolLiteral<T>` | Check for symbol literal |
| `IsAny<T>` | Check for `any` |
| `IsNever<T>` | Check for `never` |
| `IsUnknown<T>` | Check for `unknown` |
| `IsNull<T>` | Check for `null` |
| `IsUndefined<T>` | Check for `undefined` |
| `IsOptional<T>` | Check if includes `undefined` |
| `IsNullable<T>` | Check if includes `null` |
| `IsEmptyObject<T>` | Check for empty object |
| `IsTuple<T>` | Check if array is a tuple |
| `IsUnion<T>` | Check if union type |
| `IsLowercase<S>` | Check if string is lowercase |
| `IsUppercase<S>` | Check if string is uppercase |
| `IsOptionalKeyOf<T, K>` | Check if key is optional |
| `IsRequiredKeyOf<T, K>` | Check if key is required |
| `IsReadonlyKeyOf<T, K>` | Check if key is readonly |
| `IsWritableKeyOf<T, K>` | Check if key is writable |

## Function Types

| Type | Description |
|------|-------------|
| `SetReturnType<F, R>` | Replace function's return type |
| `SetParameterType<F, P>` | Replace function's parameters |

## Tagged/Branded Types

| Type | Description |
|------|-------------|
| `Tagged<T, Tag>` | Create a tagged/branded type |
| `UnwrapTagged<T>` | Get the underlying type without the tag |
| `InvariantOf<T>` | Make type invariant (not covariant/contravariant) |

## Stricter Built-ins

| Type | Description |
|------|-------------|
| `ExtendsStrict<T, U>` | Non-distributive `extends` check |
| `ExtractStrict<T, U>` | Non-distributive `Extract` |
| `ExcludeStrict<T, U>` | Non-distributive `Exclude` |

## Miscellaneous

| Type | Description |
|------|-------------|
| `PackageJson` | Full type for npm's `package.json` |
| `TsConfigJson` | Full type for TypeScript's `tsconfig.json` |
| `GlobalThis` | Declare scoped globalThis properties |
| `FindGlobalType<Name>` | Find a global type by name string |
| `FindGlobalInstanceType<Name>` | Find global constructor instance type |
| `LiteralToPrimitive<T>` | Widen `'hello'` to `string`, `42` to `number` |
| `Stringified<T>` | All values become `string` |
| `IterableElement<T>` | Element type of any iterable |
| `Entry<T>` | Entry type (`[key, value]`) of a collection |
| `Entries<T>` | Array of entries from a collection |
| `UnwrapPartial<T>` | Revert `Partial` modifier |
| `Optional<T>` | `T \| undefined` |
| `RequireAtLeastOne<T, K>` | At least one of K keys required |
| `RequireExactlyOne<T, K>` | Exactly one of K keys required |
| `RequireAllOrNone<T, K>` | All or none of K keys |
| `RequireOneOrNone<T, K>` | Exactly one or none of K keys |
| `And<A, B>` | Boolean AND at type level |
| `Or<A, B>` | Boolean OR at type level |
| `Xor<A, B>` | Boolean XOR at type level |
| `AllExtend<T, U>` | Check if all members extend U |
| `ArrayIndices<A>` | Valid index types for array |
| `ArrayValues<A>` | All value types in array |
| `Get<T, Path>` | Get nested property type by dot path |
| `Paths<T>` | Union of all dot-notation paths |
