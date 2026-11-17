/**
 * Aggregation expressions the dashboards' cards share.
 */

import type { Prisma } from '#prisma-lib/client';

/**
 * The expression of the UTC week, starting on Monday, of a date.
 */
export function weekOf(date: Prisma.InputJsonValue): Prisma.InputJsonObject {
  return { $dateTrunc: { date, unit: 'week', startOfWeek: 'monday' } };
}

/**
 * The expression of the UTC day of a date.
 */
export function dayOf(date: Prisma.InputJsonValue): Prisma.InputJsonObject {
  return { $dateTrunc: { date, unit: 'day' } };
}

/**
 * The expression dividing two sums, or null where the divisor is 0.
 */
export function ratioExpression(dividend: string, divisor: string): Prisma.InputJsonObject {
  return { $cond: [{ $gt: [divisor, 0] }, { $divide: [dividend, divisor] }, null] };
}

/**
 * The expression of the Monday starting the window of the given number of ended weeks, the week in
 * progress left out.
 */
export function windowStart(weeks: number): Prisma.InputJsonObject {
  return { $dateSubtract: { startDate: weekOf('$$NOW'), unit: 'week', amount: weeks } };
}

/**
 * The expression of whether a date falls in the given number of ended weeks.
 */
export function isInLastWeeks(date: string, weeks: number): Prisma.InputJsonObject {
  return { $and: [{ $gte: [date, windowStart(weeks)] }, { $lt: [date, weekOf('$$NOW')] }] };
}

/**
 * The expression of a field of an object whose key holds dots, which a field path would read as
 * nested fields.
 */
export function dottedField(object: string, key: string): Prisma.InputJsonObject {
  return { $getField: { field: { $literal: key }, input: object } };
}

/**
 * The expression of whether a value is above 0, as 1 or 0.
 */
export function isPositive(value: Prisma.InputJsonValue): Prisma.InputJsonObject {
  return { $cond: [{ $gt: [value, 0] }, 1, 0] };
}
