/**
 * @param value The value that triggered this supposedly unreachable code path.
 *
 * @returns This function does not return; it always throws an error.
 *   This function represents a code path that should never be reached.
 *   It is typically used to handle impossible cases in TypeScript's exhaustiveness checks.
 */
export function unreachable(value?: never): never {
  let stringifiable = String(value);

  try {
    if (value && typeof value == 'object') {
      stringifiable = JSON.stringify(value, null, 2);
    }
  } catch {
    // If JSON.stringify() fails (ex. due to circular references), it will fall back to the default
    // stringification.
  }

  throw new Error(`Supposedly unreachable code was reached with value: ${stringifiable}`);
}

/**
 * Checks that a given value is not strictly null OR strictly undefined (nn = non-null).
 *
 * @throws {TypeError} If the value is `null` or `undefined`.
 */
export function nn<TNonNull>(value: TNonNull | null | undefined): TNonNull {
  if (value === undefined || value === null) {
    throw expectedValueTypeMismatchError('not null or undefined', value);
  }

  return value;
}

nn.assert = <TNonNull>(value: TNonNull | null | undefined): asserts value is TNonNull => {
  nn(value);
};

/**
 * Checks that a given value is a boolean.
 *
 * @throws {TypeError} If the value is not a boolean.
 */
export function ensureBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw expectedValueTypeMismatchError('a boolean', value);
  }

  return value;
}

ensureBoolean.assert = (value: unknown): asserts value is boolean => {
  ensureBoolean(value);
};

/**
 * Checks that a given value is a number.
 *
 * @throws {TypeError} If the value is not a number.
 */
export function ensureNumber(value: unknown): number {
  if (typeof value !== 'number') {
    throw expectedValueTypeMismatchError('a number', value);
  }

  return value;
}

ensureNumber.assert = (value: unknown): asserts value is number => {
  ensureNumber(value);
};

/**
 * Checks that a given value is a string.
 *
 * @throws {TypeError} If the value is not a string.
 */
export function ensureString(value: unknown): string {
  if (typeof value !== 'string') {
    throw expectedValueTypeMismatchError('a string', value);
  }

  return value;
}

ensureString.assert = (value: unknown): asserts value is string => {
  ensureString(value);
};

/**
 * Checks that a given value is a member of a given enum.
 *
 * @throws {TypeError} If the value is not a valid member of the enum.
 */
export function ensureInEnum<TEnum extends Record<string, unknown>>(
  value: unknown,
  enumType: TEnum
): TEnum[keyof TEnum] {
  if (!Object.values(enumType).includes(value)) {
    throw expectedValueTypeMismatchError('an enum value', value);
  }

  return value as TEnum[keyof TEnum];
}

ensureInEnum.assert = <TEnum extends Record<string, unknown>>(
  value: unknown,
  enumType: TEnum
): asserts value is TEnum[keyof TEnum] => {
  ensureInEnum(value, enumType);
};

function expectedValueTypeMismatchError(expected: string, value: unknown): TypeError {
  return new TypeError(
    `Expected value to be ${expected}, found (${typeof value}) ${String(value)}.`
  );
}
