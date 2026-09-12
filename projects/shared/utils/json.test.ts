import { describe, expect, expectTypeOf, test } from 'bun:test';
import { type JsonObject, optionallySerialized } from './json';

describe('optionallySerialized', () => {
  test(`returns the value as is`, () => {
    const value = { cityName: 'Colossal City' };

    expect(optionallySerialized(value)).toBe(value);
    expect(optionallySerialized(undefined)).toBeUndefined();
  });

  test(`lets a JsonObject field be undefined, omitted from the JSON output`, () => {
    const description = undefined as string | undefined;

    expectTypeOf({ description }).not.toExtend<JsonObject>();

    const json = { cityName: 'Colossal City', description: optionallySerialized(description) };

    expectTypeOf(json).toExtend<JsonObject>();

    expect(JSON.stringify(json)).toBe(`{"cityName":"Colossal City"}`);
  });
});
