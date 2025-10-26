/**
 * @public
 * Checks that a given value is not strictly null OR strictly undefined (nn = non-null).
 *
 * @throws Error if the value is `null` or `undefined`.
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
 * @public
 * Checks that a given value is a boolean.
 *
 * @throws Error if the value is not a boolean.
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
 * @public
 * Checks that a given value is a number.
 *
 * @throws Error if the value is not a number.
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
 * @public
 * Checks that a given value is a string.
 *
 * @throws Error if the value is not a string.
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
 * @public
 * Checks that a given value is a member of a given enum.
 *
 * @throws Error if the value is not a valid member of the enum.
 */
export function ensureInEnum<TEnum extends { [key: string]: unknown }>(
  value: unknown,
  enumType: TEnum
): TEnum[keyof TEnum] {
  if (!Object.values(enumType).includes(value)) {
    throw expectedValueTypeMismatchError('an enum value', value);
  }

  return value as TEnum[keyof TEnum];
}

ensureInEnum.assert = <TEnum extends { [key: string]: unknown }>(
  value: unknown,
  enumType: TEnum
): asserts value is TEnum[keyof TEnum] => {
  ensureInEnum(value, enumType);
};

function expectedValueTypeMismatchError(expected: string, value: unknown): TypeError {
  return new TypeError(`Expected value to be ${expected}, found (${typeof value}) ${value}.`);
}
