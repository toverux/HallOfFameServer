import { describe, expect, expectTypeOf, test } from 'bun:test';
import * as Bun from 'bun';
import { allFulfilled } from './all-fulfilled';

describe('allFulfilled', () => {
  test(`resolves to the values of all promises, in order and typed as a tuple`, async () => {
    const values = await allFulfilled([
      resolveLater(1),
      Promise.resolve('two'),
      Promise.resolve(3)
    ]);

    expect(values).toEqual([1, 'two', 3]);
    expectTypeOf(values).toEqualTypeOf<[number, string, number]>();
  });

  test(`resolves no promises to an empty array`, async () => {
    expect(await allFulfilled([])).toEqual([]);
  });

  test(`throws a single rejection reason as is, even when aggregating`, () => {
    const error = new Error(`only`);

    expect(allFulfilled([Promise.resolve(1), Promise.reject(error)], true)).rejects.toBe(error);
  });

  test(`throws the reason of the first promise to reject in array order`, () => {
    const first = new Error(`first`);

    const second = new Error(`second`);

    expect(allFulfilled([rejectLater(first), Promise.reject(second)])).rejects.toBe(first);
  });

  test(`waits for every promise to settle before throwing`, () => {
    const error = new Error(`fast`);

    let isSlowSettled = false;

    async function slow(): Promise<void> {
      await Bun.sleep(5);

      isSlowSettled = true;
    }

    expect(allFulfilled([Promise.reject(error), slow()])).rejects.toBe(error);

    expect(isSlowSettled).toBe(true);
  });

  test(`throws an AggregateError of every rejection when aggregating`, () => {
    const first = new Error(`first`);

    const second = new Error(`second`);

    const result = allFulfilled(
      [Promise.reject(first), Promise.resolve(1), rejectLater(second)],
      true
    );

    expect(result).rejects.toBeInstanceOf(AggregateError);

    expect(result).rejects.toMatchObject({
      errors: [first, second],
      message: `Error: first\nError: second`
    });
  });
});

async function resolveLater<T>(value: T): Promise<T> {
  await Bun.sleep(1);

  return value;
}

async function rejectLater(reason: Error): Promise<never> {
  await Bun.sleep(1);

  throw reason;
}
