import { describe, expect, test } from 'bun:test';
import {
  ensureBoolean,
  ensureInEnum,
  ensureNumber,
  ensureString,
  nn,
  unreachable
} from './type-assertion';

describe('unreachable', () => {
  test(`throws with a primitive value stringified`, () => {
    expect(() => unreachable('circle' as never)).toThrow(
      new Error(`Supposedly unreachable code was reached with value: circle`)
    );

    expect(() => unreachable()).toThrow(
      new Error(`Supposedly unreachable code was reached with value: undefined`)
    );
  });

  test(`throws with an object value as indented JSON`, () => {
    expect(() => unreachable({ kind: 'circle' } as never)).toThrow(
      new Error(`Supposedly unreachable code was reached with value: {\n  "kind": "circle"\n}`)
    );
  });

  test(`falls back to default stringification for an object JSON cannot serialize`, () => {
    const circular: Record<string, unknown> = {};

    circular.self = circular;

    expect(() => unreachable(circular as never)).toThrow(
      new Error(`Supposedly unreachable code was reached with value: [object Object]`)
    );
  });
});

describe('nn', () => {
  test(`returns a non-null value as is, falsy values included`, () => {
    expect(nn(0)).toBe(0);
    expect(nn('')).toBe('');
    expect(nn(false)).toBe(false);
  });

  test(`throws a TypeError for null and undefined`, () => {
    expect(() => nn(null)).toThrow(
      new TypeError(`Expected value to be not null or undefined, found (object) null.`)
    );

    expect(() => nn(undefined)).toThrow(
      new TypeError(`Expected value to be not null or undefined, found (undefined) undefined.`)
    );
  });

  test(`.assert passes a non-null value and throws for null`, () => {
    expect(() => nn.assert(0)).not.toThrow();
    expect(() => nn.assert(null)).toThrow(TypeError);
  });
});

describe('ensureBoolean', () => {
  test(`returns a boolean as is`, () => {
    expect(ensureBoolean(false)).toBe(false);
  });

  test(`throws a TypeError for any other type`, () => {
    expect(() => ensureBoolean('false')).toThrow(
      new TypeError(`Expected value to be a boolean, found (string) false.`)
    );
  });

  test(`.assert passes a boolean and throws for any other type`, () => {
    expect(() => ensureBoolean.assert(true)).not.toThrow();
    expect(() => ensureBoolean.assert(1)).toThrow(TypeError);
  });
});

describe('ensureNumber', () => {
  test(`returns a number as is`, () => {
    expect(ensureNumber(0)).toBe(0);
  });

  test(`throws a TypeError for any other type`, () => {
    expect(() => ensureNumber('42')).toThrow(
      new TypeError(`Expected value to be a number, found (string) 42.`)
    );
  });

  test(`.assert passes a number and throws for any other type`, () => {
    expect(() => ensureNumber.assert(42)).not.toThrow();
    expect(() => ensureNumber.assert(null)).toThrow(TypeError);
  });
});

describe('ensureString', () => {
  test(`returns a string as is`, () => {
    expect(ensureString('')).toBe('');
  });

  test(`throws a TypeError for any other type`, () => {
    expect(() => ensureString(42)).toThrow(
      new TypeError(`Expected value to be a string, found (number) 42.`)
    );
  });

  test(`.assert passes a string and throws for any other type`, () => {
    expect(() => ensureString.assert('text')).not.toThrow();
    expect(() => ensureString.assert(undefined)).toThrow(TypeError);
  });
});

describe('ensureInEnum', () => {
  const Shape = { Circle: 'circle', Square: 'square' } as const;

  test(`returns an enum value as is`, () => {
    expect(ensureInEnum('square', Shape)).toBe('square');
  });

  test(`throws a TypeError for a value outside the enum, a key included`, () => {
    expect(() => ensureInEnum('triangle', Shape)).toThrow(
      new TypeError(`Expected value to be an enum value, found (string) triangle.`)
    );

    expect(() => ensureInEnum('Circle', Shape)).toThrow(TypeError);
  });

  test(`.assert passes an enum value and throws for a value outside the enum`, () => {
    expect(() => ensureInEnum.assert('circle', Shape)).not.toThrow();
    expect(() => ensureInEnum.assert('triangle', Shape)).toThrow(TypeError);
  });
});
