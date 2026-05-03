# type-fest: Transformation

Types for reshaping, converting, merging, and deeply modifying object types. Use these when you need to derive new types from existing ones.

## Merging Objects

### Basic Merge (B overrides A)
```ts
import type {Merge} from 'type-fest';

type Defaults = { retries: number; timeout: number; verbose: boolean };
type UserConfig = { timeout: string; debug: boolean };

type Config = Merge<Defaults, UserConfig>;
// => { retries: number; timeout: string; verbose: boolean; debug: boolean }
```

### Deep Merge
```ts
import type {MergeDeep} from 'type-fest';

type BaseTheme = {
  colors: { primary: string; secondary: string };
  spacing: { sm: number; md: number };
};
type CustomTheme = {
  colors: { primary: string };  // only override primary
};

type Theme = MergeDeep<BaseTheme, CustomTheme>;
// colors.secondary is preserved, colors.primary is overridden
```

### Spread (models `{...a, ...b}`)
```ts
import type {Spread} from 'type-fest';

type A = { x: number; y: string };
type B = { y: number; z: boolean };
type Result = Spread<A, B>; // { x: number; y: number; z: boolean }
```

## Making Keys Optional/Required/Readonly

### Shallow Modifiers
```ts
import type {SetOptional, SetRequired, SetReadonly, Writable} from 'type-fest';

type User = { id: number; name: string; email: string };

type CreateUser = SetOptional<User, 'id'>;          // id becomes optional
type ValidUser = SetRequired<CreateUser, 'email'>;  // email stays required
type FrozenUser = SetReadonly<User, 'id'>;           // id becomes readonly
type MutableUser = Writable<Readonly<User>>;         // strips all readonly
```

### Change Field Types
```ts
import type {SetFieldType} from 'type-fest';

type ApiUser = { id: number; createdAt: string };
type DomainUser = SetFieldType<ApiUser, 'createdAt', Date>;
// => { id: number; createdAt: Date }
```

## Deep Modifiers

These apply recursively through nested objects and arrays:

```ts
import type {PartialDeep, RequiredDeep, ReadonlyDeep, WritableDeep} from 'type-fest';

type Config = {
  db: { host: string; port: number; ssl: { cert: string } };
  cache: { ttl: number };
};

// All fields optional at every level — great for patch/update payloads
type ConfigPatch = PartialDeep<Config>;

// All fields required at every level — ensure nothing is missing
type StrictConfig = RequiredDeep<Config>;

// Immutable at every level — safe for state management
type FrozenConfig = ReadonlyDeep<Config>;

// Mutable at every level — for draft/editing states
type DraftConfig = WritableDeep<FrozenConfig>;
```

### Deep Required for Specific Keys
```ts
import type {SetRequiredDeep} from 'type-fest';

type Form = {
  user?: { name?: string; email?: string };
  settings?: { theme?: string };
};

type ValidForm = SetRequiredDeep<Form, 'user' | 'user.name'>;
// user and user.name are required, everything else stays optional
```

## Removing Keys

### Except (stricter Omit)
```ts
import type {Except} from 'type-fest';

type User = { id: number; name: string; password: string };
type PublicUser = Except<User, 'password'>;
// => { id: number; name: string }
```

`Except` is stricter than `Omit` — it errors if you try to exclude a key that doesn't exist.

### Deep Pick and Omit
```ts
import type {PickDeep, OmitDeep} from 'type-fest';

type Schema = {
  user: { name: string; address: { street: string; city: string } };
  meta: { version: number };
};

type UserAddress = PickDeep<Schema, 'user.address'>;
type WithoutMeta = OmitDeep<Schema, 'meta'>;
```

### Index Signature Manipulation
```ts
import type {OmitIndexSignature, PickIndexSignature} from 'type-fest';

type Mixed = {
  [key: string]: unknown;
  id: number;
  name: string;
};

type ExplicitOnly = OmitIndexSignature<Mixed>;  // { id: number; name: string }
type IndexOnly = PickIndexSignature<Mixed>;      // { [key: string]: unknown }
```

## Case Conversion (Property Names)

Convert all property names between naming conventions:

```ts
import type {
  CamelCasedPropertiesDeep,
  SnakeCasedPropertiesDeep,
  KebabCasedPropertiesDeep,
  PascalCasedPropertiesDeep,
} from 'type-fest';

// API returns snake_case, your code uses camelCase
type ApiResponse = {
  user_name: string;
  email_address: string;
  home_address: { street_name: string; zip_code: string };
};

type JsResponse = CamelCasedPropertiesDeep<ApiResponse>;
// => { userName: string; emailAddress: string; homeAddress: { streetName: string; zipCode: string } }

// Convert back for API calls
type ApiPayload = SnakeCasedPropertiesDeep<JsResponse>;
```

Shallow versions (without `Deep`) only convert top-level keys.

## JSON Serialization

```ts
import type {Jsonify, Jsonifiable} from 'type-fest';

type User = {
  name: string;
  createdAt: Date;         // Date becomes string in JSON
  getData: () => string;   // Functions are stripped
};

type JsonUser = Jsonify<User>;
// => { name: string; createdAt: string }
// Functions removed, Date converted to string — matches JSON.parse(JSON.stringify(user))
```

## Simplifying Types

When intersections or mapped types make hover tooltips unreadable:

```ts
import type {Simplify, SimplifyDeep} from 'type-fest';

// Before: hovering shows Pick<A, 'x'> & Pick<B, 'y'> & Omit<C, 'z'>
// After: hovering shows { x: string; y: number; ... }
type Clean = Simplify<Pick<A, 'x'> & Pick<B, 'y'>>;

// Deep version for nested types
type DeepClean = SimplifyDeep<ComplexNestedType>;
```

## Other Transformations

```ts
import type {
  OverrideProperties,
  Stringified,
  LiteralToPrimitive,
  Schema,
  UnwrapPartial,
} from 'type-fest';

// Override specific property types
type Updated = OverrideProperties<User, { id: string }>;

// Make all values strings (for form state)
type FormState = Stringified<User>;

// Widen literals: 'hello' -> string, 42 -> number
type Widened = LiteralToPrimitive<'hello'>; // string

// Replace all values with a single type (for validation schemas)
type ValidationSchema = Schema<Config, boolean>;

// Revert Partial
type Original = UnwrapPartial<Partial<User>>; // same as User
```

## All Types in This Category

| Type | Description |
|------|-------------|
| `Merge<A, B>` | Merge objects, B overrides A |
| `ObjectMerge<A, B>` | Merge specifically for objects |
| `MergeDeep<A, B>` | Recursive deep merge |
| `Spread<A, B>` | Type-level `{...a, ...b}` |
| `Except<T, K>` | Stricter Omit |
| `SetOptional<T, K>` | Make keys optional |
| `SetRequired<T, K>` | Make keys required |
| `SetReadonly<T, K>` | Make keys readonly |
| `SetFieldType<T, K, V>` | Change key types |
| `SetNonNullable<T, K>` | Remove null/undefined |
| `Writable<T>` | Remove readonly (shallow) |
| `PartialDeep<T>` | Deeply optional |
| `RequiredDeep<T>` | Deeply required |
| `ReadonlyDeep<T>` | Deeply immutable |
| `WritableDeep<T>` | Deeply mutable |
| `SetRequiredDeep<T, K>` | Deep required for specific keys |
| `SetNonNullableDeep<T, K>` | Deep non-nullable |
| `PartialOnUndefinedDeep<T>` | Optional where undefined accepted |
| `UndefinedOnPartialDeep<T>` | Accept undefined on optional |
| `UnwrapPartial<T>` | Revert Partial |
| `PickDeep<T, Path>` | Pick nested properties |
| `OmitDeep<T, Path>` | Omit nested properties |
| `OmitIndexSignature<T>` | Remove index signatures |
| `PickIndexSignature<T>` | Keep only index signatures |
| `OverrideProperties<T, U>` | Override property types |
| `Simplify<T>` | Flatten for readability |
| `SimplifyDeep<T>` | Deep flatten |
| `Stringified<T>` | All values to string |
| `LiteralToPrimitive<T>` | Widen literals |
| `LiteralToPrimitiveDeep<T>` | Deep widen |
| `Schema<T, V>` | Replace all values with V |
| `Jsonify<T>` | JSON-serialized form |
| `CamelCasedProperties<T>` | Property names to camelCase |
| `CamelCasedPropertiesDeep<T>` | Deep camelCase |
| `SnakeCasedProperties<T>` | Property names to snake_case |
| `SnakeCasedPropertiesDeep<T>` | Deep snake_case |
| `KebabCasedProperties<T>` | Property names to kebab-case |
| `KebabCasedPropertiesDeep<T>` | Deep kebab-case |
| `PascalCasedProperties<T>` | Property names to PascalCase |
| `PascalCasedPropertiesDeep<T>` | Deep PascalCase |
| `DelimiterCasedProperties<T, D>` | Custom delimiter |
| `DelimiterCasedPropertiesDeep<T, D>` | Deep custom delimiter |
| `Asyncify<F>` | Make function return Promise |
| `SetReturnType<F, R>` | Replace return type |
| `SetParameterType<F, P>` | Replace parameters |
