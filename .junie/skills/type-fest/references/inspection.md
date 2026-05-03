# type-fest: Inspection & Guards

Types for querying type properties, conditional logic, deep property access, and filtering keys by their characteristics.

## Type Guard Utilities

Check properties of types at compile time — useful in generic code and conditional types:

```ts
import type {IsEqual, IsAny, IsNever, IsLiteral, If} from 'type-fest';

// Conditional logic based on type equality
type Result = If<IsEqual<A, B>, 'same', 'different'>;

// Guard against `any` leaking into your types
type SafeInput<T> = If<IsAny<T>, never, T>;

// Handle empty unions
type HasMembers<T> = If<IsNever<T>, false, true>;

// Distinguish literal types from their base types
type IsExact = IsLiteral<'hello'>; // true
type IsWide = IsLiteral<string>;    // false
```

### Full Guard List

| Guard | Checks for |
|-------|-----------|
| `IsEqual<A, B>` | Exact type equality |
| `IsAny<T>` | `any` type |
| `IsNever<T>` | `never` type |
| `IsUnknown<T>` | `unknown` type |
| `IsNull<T>` | `null` type |
| `IsUndefined<T>` | `undefined` type |
| `IsOptional<T>` | Includes `undefined` |
| `IsNullable<T>` | Includes `null` |
| `IsLiteral<T>` | Any literal type |
| `IsStringLiteral<T>` | String literal (e.g., `'hello'`) |
| `IsNumericLiteral<T>` | Number/bigint literal (e.g., `42`) |
| `IsBooleanLiteral<T>` | `true` or `false` literal |
| `IsSymbolLiteral<T>` | Symbol literal |
| `IsEmptyObject<T>` | Empty object `{}` |
| `IsTuple<T>` | Tuple (not plain array) |
| `IsUnion<T>` | Union type |
| `IsLowercase<S>` | Lowercase string |
| `IsUppercase<S>` | Uppercase string |

### Key-Level Guards

```ts
import type {IsOptionalKeyOf, IsRequiredKeyOf} from 'type-fest';

type User = { id: number; name?: string };

type IdOptional = IsOptionalKeyOf<User, 'id'>;    // false
type NameOptional = IsOptionalKeyOf<User, 'name'>; // true
```

| Guard | Checks |
|-------|--------|
| `IsOptionalKeyOf<T, K>` | Key is optional |
| `IsRequiredKeyOf<T, K>` | Key is required |
| `IsReadonlyKeyOf<T, K>` | Key is readonly |
| `IsWritableKeyOf<T, K>` | Key is writable |

## Key Extraction

Extract sets of keys by their characteristics:

```ts
import type {OptionalKeysOf, RequiredKeysOf, ReadonlyKeysOf, WritableKeysOf} from 'type-fest';

type Config = {
  readonly id: number;
  name: string;
  debug?: boolean;
};

type OptKeys = OptionalKeysOf<Config>;  // 'debug'
type ReqKeys = RequiredKeysOf<Config>;  // 'id' | 'name'
type ROKeys = ReadonlyKeysOf<Config>;   // 'id'
type RWKeys = WritableKeysOf<Config>;   // 'name' | 'debug'
```

### Has-checks (boolean)
```ts
import type {HasOptionalKeys, HasReadonlyKeys} from 'type-fest';

type HasOpt = HasOptionalKeys<Config>;  // true
type HasRO = HasReadonlyKeys<Config>;   // true
```

## Conditional Filtering

Pick or exclude keys based on their value types:

```ts
import type {ConditionalKeys, ConditionalPick, ConditionalExcept} from 'type-fest';

type User = {
  id: number;
  name: string;
  email: string;
  age: number;
  isActive: boolean;
};

// Get keys whose values are strings
type StringKeys = ConditionalKeys<User, string>; // 'name' | 'email'

// Pick only string-valued properties
type StringProps = ConditionalPick<User, string>;
// => { name: string; email: string }

// Exclude string-valued properties
type NonStringProps = ConditionalExcept<User, string>;
// => { id: number; age: number; isActive: boolean }
```

### Deep Conditional Pick
```ts
import type {ConditionalPickDeep} from 'type-fest';

type Schema = {
  user: { name: string; age: number };
  meta: { version: string; count: number };
};

type StringFields = ConditionalPickDeep<Schema, string>;
// => { user: { name: string }; meta: { version: string } }
```

## Deep Property Access

### Get Nested Type by Path
```ts
import type {Get} from 'type-fest';

type Config = {
  db: {
    connection: { host: string; port: number };
    pool: { min: number; max: number };
  };
};

type Host = Get<Config, 'db.connection.host'>; // string
type Pool = Get<Config, 'db.pool'>;            // { min: number; max: number }
```

### All Possible Paths
```ts
import type {Paths} from 'type-fest';

type AllPaths = Paths<Config>;
// => 'db' | 'db.connection' | 'db.connection.host' | 'db.connection.port' | 'db.pool' | 'db.pool.min' | 'db.pool.max'

// Great for building type-safe dot-notation accessors:
function get<T, P extends Paths<T>>(obj: T, path: P): Get<T, P> { /* ... */ }
```

## Union Key Utilities

```ts
import type {KeysOfUnion, SharedUnionFields, SharedUnionFieldsDeep, AllUnionFields} from 'type-fest';

type Shape =
  | { type: 'circle'; radius: number }
  | { type: 'rect'; width: number; height: number };

// All keys from any member
type AllKeys = KeysOfUnion<Shape>; // 'type' | 'radius' | 'width' | 'height'

// Only keys present in ALL members
type CommonFields = SharedUnionFields<Shape>; // { type: 'circle' | 'rect' }

// All fields from any member (missing ones become optional)
type AllFields = AllUnionFields<Shape>;
```

## Value Extraction

```ts
import type {ValueOf, Entry, Entries} from 'type-fest';

type Config = { host: string; port: number; debug: boolean };

type ConfigValue = ValueOf<Config>; // string | number | boolean
type ConfigEntry = Entry<Config>;   // ['host', string] | ['port', number] | ['debug', boolean]
type ConfigEntries = Entries<Config>; // Array of entries
```

## Stricter Built-in Alternatives

TypeScript's `Extract` and `Exclude` distribute over unions by default, which can be surprising:

```ts
import type {ExtractStrict, ExcludeStrict, ExtendsStrict} from 'type-fest';

// Built-in distributes:
type A = Extract<'a' | 'b', string>;     // 'a' | 'b' (each member checked individually)

// Strict version checks the whole union:
type B = ExtractStrict<'a' | 'b', string>; // 'a' | 'b' (whole union extends string)

// But:
type C = Extract<string | number, string>;     // string (distributed)
type D = ExtractStrict<string | number, string>; // never (string | number doesn't extend string as a whole)
```

Use the strict versions when you want to check the union as a whole rather than distributing over each member.

## Boolean Logic

```ts
import type {And, Or, Xor, AllExtend} from 'type-fest';

type Both = And<true, true>;    // true
type Either = Or<true, false>;  // true
type OneOf = Xor<true, false>;  // true

// Check if all members of a tuple extend a type
type AllStrings = AllExtend<[string, string], string>; // true
```

## Miscellaneous Inspection

```ts
import type {
  IterableElement,
  ArrayIndices,
  ArrayValues,
  FindGlobalType,
  KeyAsString,
} from 'type-fest';

// Element type of any iterable
type El = IterableElement<Set<number>>; // number

// Valid indices for a tuple
type Idx = ArrayIndices<['a', 'b', 'c']>; // 0 | 1 | 2

// All values from a tuple
type Vals = ArrayValues<['a', 'b', 'c']>; // 'a' | 'b' | 'c'

// Find a global type by name string
type Err = FindGlobalType<'Error'>; // Error

// Get keys as string type
type Keys = KeyAsString<{ 0: 'a'; 1: 'b' }>; // '0' | '1'
```

## All Types in This Category

| Type | Description |
|------|-------------|
| `If<Cond, Then, Else>` | Conditional type resolution |
| `IsEqual<A, B>` | Exact type equality |
| `IsAny<T>` | Check for `any` |
| `IsNever<T>` | Check for `never` |
| `IsUnknown<T>` | Check for `unknown` |
| `IsNull<T>` | Check for `null` |
| `IsUndefined<T>` | Check for `undefined` |
| `IsOptional<T>` | Includes undefined |
| `IsNullable<T>` | Includes null |
| `IsLiteral<T>` | Any literal type |
| `IsStringLiteral<T>` | String literal |
| `IsNumericLiteral<T>` | Number/bigint literal |
| `IsBooleanLiteral<T>` | Boolean literal |
| `IsSymbolLiteral<T>` | Symbol literal |
| `IsEmptyObject<T>` | Empty object |
| `IsTuple<T>` | Tuple check |
| `IsUnion<T>` | Union check |
| `IsLowercase<S>` | Lowercase string |
| `IsUppercase<S>` | Uppercase string |
| `IsOptionalKeyOf<T, K>` | Key is optional |
| `IsRequiredKeyOf<T, K>` | Key is required |
| `IsReadonlyKeyOf<T, K>` | Key is readonly |
| `IsWritableKeyOf<T, K>` | Key is writable |
| `OptionalKeysOf<T>` | Extract optional keys |
| `RequiredKeysOf<T>` | Extract required keys |
| `ReadonlyKeysOf<T>` | Extract readonly keys |
| `WritableKeysOf<T>` | Extract writable keys |
| `HasOptionalKeys<T>` | Has optional fields |
| `HasRequiredKeys<T>` | Has required fields |
| `HasReadonlyKeys<T>` | Has readonly fields |
| `HasWritableKeys<T>` | Has writable fields |
| `ConditionalKeys<T, C>` | Keys by value type |
| `ConditionalPick<T, C>` | Pick by value type |
| `ConditionalPickDeep<T, C>` | Deep pick by value type |
| `ConditionalExcept<T, C>` | Exclude by value type |
| `Get<T, Path>` | Nested property type |
| `Paths<T>` | All dot-notation paths |
| `KeysOfUnion<U>` | All keys across union |
| `SharedUnionFields<U>` | Shared union fields |
| `SharedUnionFieldsDeep<U>` | Deep shared fields |
| `AllUnionFields<U>` | All union fields |
| `ValueOf<T>` | Union of values |
| `Entry<T>` | Entry tuple type |
| `Entries<T>` | Array of entries |
| `KeyAsString<T>` | Keys as strings |
| `ExtractStrict<T, U>` | Non-distributive Extract |
| `ExcludeStrict<T, U>` | Non-distributive Exclude |
| `ExtendsStrict<T, U>` | Non-distributive extends |
| `And<A, B>` | Boolean AND |
| `Or<A, B>` | Boolean OR |
| `Xor<A, B>` | Boolean XOR |
| `AllExtend<T, U>` | All members extend U |
| `IterableElement<T>` | Element of iterable |
| `ArrayIndices<T>` | Valid array indices |
| `ArrayValues<T>` | Array value types |
| `FindGlobalType<N>` | Global type by name |
| `FindGlobalInstanceType<N>` | Global instance type |
