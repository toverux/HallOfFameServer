# type-fest: Validation & Constraints

Types for enforcing shape rules, requiring certain keys, constraining values, and creating branded types that prevent misuse at compile time.

## Key Requirements Constraints

### Require At Least One Field
When a user must provide at least one option from a set:

```ts
import type {RequireAtLeastOne} from 'type-fest';

type ContactInfo = {
  email?: string;
  phone?: string;
  address?: string;
};

// Must provide at least one contact method
type ValidContact = RequireAtLeastOne<ContactInfo>;

// Can also restrict which keys: at least one of email or phone
type ValidDigitalContact = RequireAtLeastOne<ContactInfo, 'email' | 'phone'>;
```

### Require Exactly One Field
When exactly one option must be chosen (e.g., authentication method):

```ts
import type {RequireExactlyOne} from 'type-fest';

type AuthMethod = {
  password?: string;
  oauthToken?: string;
  apiKey?: string;
};

// Exactly one auth method must be provided
type ValidAuth = RequireExactlyOne<AuthMethod>;
```

### All Or None
When a group of fields must appear together or not at all:

```ts
import type {RequireAllOrNone} from 'type-fest';

type ShippingInfo = {
  name: string;
  street?: string;
  city?: string;
  zip?: string;
};

// If any address field is present, all must be present
type ValidShipping = RequireAllOrNone<ShippingInfo, 'street' | 'city' | 'zip'>;
```

### One Or None
When at most one field from a group can be present:

```ts
import type {RequireOneOrNone} from 'type-fest';

type Layout = {
  columns?: number;
  rows?: number;
};

// Either columns OR rows, not both
type ValidLayout = RequireOneOrNone<Layout>;
```

## Mutually Exclusive Types

### MergeExclusive
When two shapes are alternatives — one or the other, never both:

```ts
import type {MergeExclusive} from 'type-fest';

type InlineCode = { code: string; language: string };
type FileRef = { filePath: string };

// Either inline code OR file reference, never mixed
type CodeSource = MergeExclusive<InlineCode, FileRef>;
```

### ExclusifyUnion
Make all members of a union mutually exclusive:

```ts
import type {ExclusifyUnion} from 'type-fest';

type Shape =
  | { type: 'circle'; radius: number }
  | { type: 'rect'; width: number; height: number };

// Prevents accidentally having both radius and width on the same object
type StrictShape = ExclusifyUnion<Shape>;
```

### SingleKeyObject
Accept only objects with exactly one key:

```ts
import type {SingleKeyObject} from 'type-fest';

// Only accepts { foo: 'bar' } but not { foo: 'bar', baz: 'qux' }
function process(filter: SingleKeyObject<Record<string, string>>) { /* ... */ }
```

## Branded/Tagged Types

Prevent accidentally mixing structurally identical types (like different ID strings):

```ts
import type {Tagged, UnwrapTagged} from 'type-fest';

// Create distinct types for different IDs
type UserId = Tagged<string, 'UserId'>;
type PostId = Tagged<string, 'PostId'>;
type Email = Tagged<string, 'Email'>;

function getUser(id: UserId): User { /* ... */ }
function getPost(id: PostId): Post { /* ... */ }

// TypeScript prevents mixing them up:
const userId = 'abc' as UserId;
const postId = 'xyz' as PostId;

getUser(userId);  // OK
getUser(postId);  // Type error! Can't pass PostId where UserId expected

// Unwrap when you need the raw string:
type RawId = UnwrapTagged<UserId>; // string
```

### InvariantOf
Make a type invariant (neither covariant nor contravariant):

```ts
import type {InvariantOf} from 'type-fest';

// Prevents widening or narrowing in generic contexts
type StrictContainer<T> = { value: InvariantOf<T> };
```

## Numeric Constraints

### IntRange / IntClosedRange
Create a union of valid integer values:

```ts
import type {IntRange, IntClosedRange} from 'type-fest';

// Port numbers: 0 to 65534 (excludes end)
type Port = IntRange<0, 65535>;

// HTTP success codes: 200 to 299 (includes end)
type SuccessCode = IntClosedRange<200, 299>;

// Month numbers: 1 to 12
type Month = IntClosedRange<1, 12>;
```

### Numeric Type Guards

```ts
import type {Integer, Float, Finite, Negative, NonNegative} from 'type-fest';

function setAge<T extends number>(age: NonNegativeInteger<T>) { /* ... */ }
function setScore<T extends number>(score: Finite<T>) { /* ... */ }
```

### Numeric Comparisons

```ts
import type {GreaterThan, LessThan, Sum, Subtract} from 'type-fest';

type IsAdult = GreaterThanOrEqual<18, 18>; // true
type Total = Sum<10, 20>; // 30
```

## Non-Empty Constraints

```ts
import type {NonEmptyTuple, NonEmptyString, NonEmptyObject} from 'type-fest';

// Ensure arrays have at least one element
function first<T>(arr: NonEmptyTuple & T[]): T { return arr[0]; }

// Ensure strings aren't empty
type Label = NonEmptyString;
```

## Nullability Constraints

```ts
import type {SetNonNullable, SetNonNullableDeep} from 'type-fest';

type User = {
  name: string | null;
  email: string | undefined;
  profile?: { bio: string | null } | null;
};

// Remove null/undefined from specific keys
type ValidUser = SetNonNullable<User, 'name' | 'email'>;
// => { name: string; email: string; profile?: { bio: string | null } | null }

// Remove null/undefined deeply
type StrictUser = SetNonNullableDeep<User>;
// => { name: string; email: string; profile?: { bio: string } }
```

## All Types in This Category

| Type | Description |
|------|-------------|
| `RequireAtLeastOne<T, K?>` | At least one of K keys required |
| `RequireExactlyOne<T, K?>` | Exactly one of K keys required |
| `RequireAllOrNone<T, K>` | All or none of K keys |
| `RequireOneOrNone<T, K>` | Exactly one or none of K keys |
| `MergeExclusive<A, B>` | Either A's keys or B's keys, never both |
| `ExclusifyUnion<U>` | Make union members mutually exclusive |
| `SingleKeyObject<T>` | Only accepts single-key objects |
| `Tagged<T, Tag>` | Create branded/tagged type |
| `UnwrapTagged<T>` | Get underlying type without tag |
| `InvariantOf<T>` | Make type invariant |
| `IntRange<Start, End>` | Union of integers (excludes end) |
| `IntClosedRange<Start, End>` | Union of integers (includes end) |
| `Integer<T>` | Constrain to integer |
| `Float<T>` | Constrain to non-integer |
| `Finite<T>` | Constrain to finite number |
| `Negative<T>` | Constrain to negative |
| `NonNegative<T>` | Constrain to >= 0 |
| `NegativeInteger<T>` | Negative integer constraint |
| `NonNegativeInteger<T>` | Non-negative integer constraint |
| `NonEmptyTuple` | Tuple with >= 1 element |
| `NonEmptyString` | String that isn't `''` |
| `NonEmptyObject<T>` | Object with >= 1 non-optional key |
| `SetNonNullable<T, K>` | Remove null/undefined from keys |
| `SetNonNullableDeep<T, K>` | Deeply remove null/undefined |
| `Exact<T, Shape>` | Disallow extra properties |
