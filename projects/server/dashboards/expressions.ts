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
