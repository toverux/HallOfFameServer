/**
 * Duration helpers that return a number of milliseconds, so durations can be expressed legibly
 * (ex. `minutes(5)`) instead of as bare arithmetic (`5 * 60 * 1000`).
 */

/**
 * @returns The given number of seconds expressed in milliseconds.
 */
export function seconds(count: number): number {
  return count * 1000;
}

/**
 * @returns The given number of minutes expressed in milliseconds.
 */
export function minutes(count: number): number {
  return count * 60 * 1000;
}

/**
 * @returns The given number of hours expressed in milliseconds.
 */
export function hours(count: number): number {
  return count * 60 * 60 * 1000;
}
