import { describe, expect, test } from 'bun:test';
import { hours, minutes, seconds } from './duration';

describe('duration helpers', () => {
  test(`seconds() converts seconds to milliseconds`, () => {
    expect(seconds(30)).toBe(30_000);
  });

  test(`minutes() converts minutes to milliseconds`, () => {
    expect(minutes(5)).toBe(300_000);
  });

  test(`hours() converts hours to milliseconds, fractions included`, () => {
    expect(hours(1.5)).toBe(5_400_000);
  });
});
