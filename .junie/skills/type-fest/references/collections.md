# type-fest: Collections

Types for working with arrays, tuples, strings, numbers, unions, intersections, JSON, and async utilities.

## Array & Tuple Types

### Extract Element Types
```ts
import type {ArrayElement, LastArrayElement} from 'type-fest';

type El = ArrayElement<string[]>;            // string
type Last = LastArrayElement<[1, 2, 3]>;     // 3
```

### Fixed-Length Arrays
```ts
import type {FixedLengthArray} from 'type-fest';

// Exactly 3 strings
type RGB = FixedLengthArray<number, 3>; // [number, number, number]

function setColor(rgb: FixedLengthArray<number, 3>) { /* ... */ }
```

### Tuple Utilities
```ts
import type {
  TupleToUnion, UnionToTuple, TupleToObject,
  TupleOf, NonEmptyTuple, ReadonlyTuple,
  ArrayTail, ArrayReverse, ArrayLength,
} from 'type-fest';

type Union = TupleToUnion<['a', 'b', 'c']>;     // 'a' | 'b' | 'c'
type Tuple = UnionToTuple<'a' | 'b'>;            // ['a', 'b'] (order not guaranteed)
type Obj = TupleToObject<[{id: 1}, {id: 2}]>;    // Transform to object

type ThreeNums = TupleOf<number, 3>;              // [number, number, number]
type Tail = ArrayTail<[1, 2, 3]>;                 // [2, 3]
type Rev = ArrayReverse<[1, 2, 3]>;               // [3, 2, 1]
type Len = ArrayLength<[1, 2, 3]>;                // 3
```

### Array Manipulation
```ts
import type {ArraySlice, ArraySplice, Includes, Arrayable} from 'type-fest';

type Sliced = ArraySlice<[1, 2, 3, 4], 1, 3>;    // [2, 3]
type Spliced = ArraySplice<[1, 2, 3], 1, 1, [9]>; // [1, 9, 3]
type Has = Includes<[1, 2, 3], 2>;                 // true

// Accept single value or array
type Input = Arrayable<string>; // string | string[]
```

### Multidimensional Arrays
```ts
import type {MultidimensionalArray} from 'type-fest';

type Matrix = MultidimensionalArray<number, 2>; // number[][]
type Cube = MultidimensionalArray<number, 3>;   // number[][][]
```

### Rest Element Utilities
```ts
import type {SplitOnRestElement, ExtractRestElement, ExcludeRestElement} from 'type-fest';

type T = [string, ...number[], boolean];
type Split = SplitOnRestElement<T>;      // { before: [string]; rest: number[]; after: [boolean] }
type Rest = ExtractRestElement<T>;       // number
type NoRest = ExcludeRestElement<T>;     // [string, boolean]
```

## String Template Types

### Case Conversion
```ts
import type {CamelCase, PascalCase, KebabCase, SnakeCase, ScreamingSnakeCase, DelimiterCase} from 'type-fest';

type A = CamelCase<'foo-bar-baz'>;          // 'fooBarBaz'
type B = PascalCase<'foo-bar-baz'>;         // 'FooBarBaz'
type C = KebabCase<'fooBarBaz'>;            // 'foo-bar-baz'
type D = SnakeCase<'fooBarBaz'>;            // 'foo_bar_baz'
type E = ScreamingSnakeCase<'fooBarBaz'>;   // 'FOO_BAR_BAZ'
type F = DelimiterCase<'fooBarBaz', '.'>;   // 'foo.bar.baz'
```

### String Manipulation
```ts
import type {Split, Join, Trim, Replace, Words, StringSlice, StringRepeat, RemovePrefix} from 'type-fest';

type Parts = Split<'a.b.c', '.'>;           // ['a', 'b', 'c']
type Joined = Join<['a', 'b', 'c'], '-'>;   // 'a-b-c'
type Trimmed = Trim<'  hello  '>;           // 'hello'
type Replaced = Replace<'foo-bar', '-', '_'>; // 'foo_bar'
type W = Words<'fooBarBaz'>;                // ['foo', 'Bar', 'Baz']
type Slice = StringSlice<'hello', 1, 3>;    // 'el'
type Rep = StringRepeat<'ab', 3>;           // 'ababab'
type NoPrefix = RemovePrefix<'/api/users', '/api'>; // '/users'
```

## Numeric Types

### Ranges
```ts
import type {IntRange, IntClosedRange} from 'type-fest';

type Dice = IntClosedRange<1, 6>;    // 1 | 2 | 3 | 4 | 5 | 6
type Index = IntRange<0, 10>;         // 0 | 1 | 2 | ... | 9 (excludes 10)
```

### Arithmetic
```ts
import type {Sum, Subtract, GreaterThan, LessThan, GreaterThanOrEqual, LessThanOrEqual} from 'type-fest';

type Total = Sum<15, 27>;                    // 42
type Diff = Subtract<100, 42>;               // 58
type Big = GreaterThan<10, 5>;               // true
type Small = LessThan<3, 7>;                 // true
type GTE = GreaterThanOrEqual<5, 5>;         // true
```

### Numeric Constraints
```ts
import type {Integer, Float, Finite, Negative, NonNegative, PositiveInfinity, NegativeInfinity} from 'type-fest';

function setCount<T extends number>(n: Integer<T>) { /* ... */ }
function setRatio<T extends number>(r: Float<T>) { /* ... */ }

// Type-level checks
type IsNeg = IsNegative<-5>;   // true
type IsInt = IsInteger<42>;    // true
type IsFlt = IsFloat<3.14>;   // true
```

## Union & Intersection Transforms

```ts
import type {
  UnionToIntersection,
  DistributedOmit, DistributedPick,
  ExclusifyUnion,
  LiteralUnion,
  TaggedUnion,
} from 'type-fest';

// Merge all union members into intersection
type Merged = UnionToIntersection<{a: 1} | {b: 2}>; // {a: 1} & {b: 2}

// Apply Omit/Pick to each union member separately
type WithoutId = DistributedOmit<{id: number; name: string} | {id: number; age: number}, 'id'>;
// => {name: string} | {age: number}

// Literal union with autocomplete but accepting any string
type Color = LiteralUnion<'red' | 'blue' | 'green', string>;
// Autocompletes 'red', 'blue', 'green' but accepts any string

// Create discriminated unions
type Shape = TaggedUnion<'type', {
  circle: { radius: number };
  rect: { width: number; height: number };
}>;
// => { type: 'circle'; radius: number } | { type: 'rect'; width: number; height: number }
```

## JSON Types

```ts
import type {JsonValue, JsonPrimitive, JsonObject, JsonArray, Jsonify, Jsonifiable} from 'type-fest';

// Accept any JSON-compatible value
function parseConfig(raw: JsonValue): Config { /* ... */ }

// What does JSON.parse(JSON.stringify(x)) return?
type Serialized = Jsonify<{ date: Date; fn: () => void; name: string }>;
// => { date: string; name: string } — Date becomes string, function removed

// Check if a value can be safely JSON.stringify'd
function toJson<T extends Jsonifiable>(value: T): string {
  return JSON.stringify(value);
}
```

## Structured Clone

```ts
import type {StructuredCloneable} from 'type-fest';

// Values that work with structuredClone()
function deepCopy<T extends StructuredCloneable>(value: T): T {
  return structuredClone(value);
}
```

## Async Types

```ts
import type {Promisable, AsyncReturnType, Asyncify} from 'type-fest';

// Accept sync or async values
function process(input: Promisable<string>) {
  // input is string | PromiseLike<string>
}

// Get the unwrapped return type of an async function
type Result = AsyncReturnType<typeof fetchUser>; // User (not Promise<User>)

// Convert sync function signature to async
type SyncFn = (x: number) => string;
type AsyncFn = Asyncify<SyncFn>; // (x: number) => Promise<string>
```

## Basic/Primitive Types

```ts
import type {Primitive, TypedArray, EmptyObject, UnknownRecord, UnknownArray, Optional} from 'type-fest';

type P = Primitive; // string | number | boolean | bigint | symbol | undefined | null

function processBuffer(buf: TypedArray) { /* Uint8Array, Float32Array, etc. */ }

// Truly empty object (not Record<string, unknown>)
const empty: EmptyObject = {};

// Unknown but structured
const data: UnknownRecord = { anything: 'goes' };

// Value or undefined
type MaybeString = Optional<string>; // string | undefined
```

## Config File Types

```ts
import type {PackageJson, TsConfigJson} from 'type-fest';

// Full type for package.json
function readPkg(path: string): PackageJson { /* ... */ }

// Full type for tsconfig.json
function readTsConfig(path: string): TsConfigJson { /* ... */ }
```

## All Types in This Category

| Type | Description |
|------|-------------|
| **Arrays** | |
| `ArrayElement<A>` | Element type from array |
| `LastArrayElement<A>` | Last element type |
| `FixedLengthArray<T, N>` | Array with N elements |
| `MultidimensionalArray<T, D>` | N-dimensional array |
| `ReadonlyTuple<T>` | Readonly tuple |
| `NonEmptyTuple` | Tuple with >= 1 element |
| `TupleToUnion<T>` | Tuple to union |
| `UnionToTuple<U>` | Union to tuple |
| `TupleToObject<T>` | Tuple to object |
| `TupleOf<T, N>` | Tuple of T with length N |
| `ArraySlice<A, S, E>` | Slice of array |
| `ArraySplice<A, S, C, I>` | Splice array |
| `ArrayTail<A>` | Without first element |
| `ArrayReverse<A>` | Reverse order |
| `ArrayLength<A>` | Tuple length |
| `Arrayable<T>` | T or T[] |
| `Includes<A, T>` | Array contains type |
| **Strings** | |
| `CamelCase<S>` | To camelCase |
| `PascalCase<S>` | To PascalCase |
| `KebabCase<S>` | To kebab-case |
| `SnakeCase<S>` | To snake_case |
| `ScreamingSnakeCase<S>` | To SCREAMING_SNAKE |
| `DelimiterCase<S, D>` | Custom delimiter |
| `Split<S, D>` | Split to tuple |
| `Join<A, D>` | Join to string |
| `Trim<S>` | Remove whitespace |
| `Replace<S, F, T>` | Replace substring |
| `Words<S>` | Split into words |
| `StringSlice<S, S, E>` | String slice |
| `StringRepeat<S, N>` | Repeat string |
| `RemovePrefix<S, P>` | Remove prefix |
| `NonEmptyString` | Not empty string |
| **Numbers** | |
| `IntRange<S, E>` | Integer range (open) |
| `IntClosedRange<S, E>` | Integer range (closed) |
| `Sum<A, B>` | Add numbers |
| `Subtract<A, B>` | Subtract numbers |
| `GreaterThan<A, B>` | A > B |
| `LessThan<A, B>` | A < B |
| `Integer<T>` | Integer constraint |
| `Float<T>` | Float constraint |
| `Finite<T>` | Finite constraint |
| `Negative<T>` | Negative constraint |
| `NonNegative<T>` | >= 0 constraint |
| **Unions** | |
| `UnionToIntersection<U>` | Union to intersection |
| `DistributedOmit<U, K>` | Omit per member |
| `DistributedPick<U, K>` | Pick per member |
| `ExclusifyUnion<U>` | Mutual exclusion |
| `LiteralUnion<L, B>` | Literals + base |
| `TaggedUnion<Tag, M>` | Discriminated union |
| **JSON** | |
| `JsonValue` | Any JSON value |
| `JsonPrimitive` | JSON primitive |
| `JsonObject` | JSON object |
| `JsonArray` | JSON array |
| `Jsonify<T>` | JSON-serialized form |
| `Jsonifiable` | JSON-safe values |
| **Async** | |
| `Promisable<T>` | T or PromiseLike<T> |
| `AsyncReturnType<F>` | Unwrap async return |
| `Asyncify<F>` | Make async |
| **Other** | |
| `StructuredCloneable` | structuredClone-safe |
| `Primitive` | Any primitive |
| `TypedArray` | Any typed array |
| `EmptyObject` | True empty object |
| `UnknownRecord` | Record<string, unknown> |
| `UnknownArray` | unknown[] |
| `UnknownMap` | Map<unknown, unknown> |
| `UnknownSet` | Set<unknown> |
| `Optional<T>` | T or undefined |
| `PackageJson` | package.json type |
| `TsConfigJson` | tsconfig.json type |
