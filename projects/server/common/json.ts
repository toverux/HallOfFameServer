import { Branded } from './branded-types';

export type JsonPrimitive = string | number | boolean | null;

export type JsonList = JsonValue[];

export type JsonObject = { [key: string]: JsonValue | JsonNonSerialized };

export type JsonValue = JsonPrimitive | JsonObject | JsonList;

type JsonNonSerialized = Branded<undefined, 'Unserialized Field'>;

/**
 * To preserve type safety of {@link JsonObject} regarding undefined values, which are not
 * translatable to JSON but can be used to dynamically *avoid* serialization of a field.
 *
 * Ex. we want to serialize `{ prop: value }`, value being `T | undefined`.
 *  - Either we made a mistake and undefined should not be allowed, in which case {@link JsonObject}
 *    will correctly reject the value.
 *  - Or we just want to avoid serializing the field if the value is undefined, then we can wrap the
 *    value with this function, which returns a special branded type that {@link JsonObject} will
 *    accept.
 */
export function optionallySerialized<T extends JsonValue>(
  value: T | undefined
): T | JsonNonSerialized {
  return value as T | JsonNonSerialized;
}
