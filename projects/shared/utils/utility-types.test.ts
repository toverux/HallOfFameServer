import { describe, expectTypeOf, test } from 'bun:test';
import type { Maybe, MaybePromise, MaybeThunk } from './utility-types';

// Type-level only: tsc checks these assertions, they do nothing at runtime.
describe('utility types', () => {
  test(`Maybe accepts the value, null, and undefined`, () => {
    expectTypeOf<string>().toExtend<Maybe<string>>();
    expectTypeOf<null>().toExtend<Maybe<string>>();
    expectTypeOf<undefined>().toExtend<Maybe<string>>();
    expectTypeOf<number>().not.toExtend<Maybe<string>>();
  });

  test(`MaybePromise accepts the value and any thenable of it`, () => {
    expectTypeOf<number>().toExtend<MaybePromise<number>>();
    expectTypeOf<Promise<number>>().toExtend<MaybePromise<number>>();
    expectTypeOf<PromiseLike<number>>().toExtend<MaybePromise<number>>();
    expectTypeOf<Promise<string>>().not.toExtend<MaybePromise<number>>();
  });

  test(`MaybeThunk accepts the value and a function returning it`, () => {
    expectTypeOf<number>().toExtend<MaybeThunk<number>>();
    expectTypeOf<() => number>().toExtend<MaybeThunk<number>>();
    expectTypeOf<() => string>().not.toExtend<MaybeThunk<number>>();
  });
});
