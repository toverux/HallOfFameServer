/**
 * Stages shared by the cohort cards, which run on `creators`.
 * A newcomer cohort is the creators whose account was created in the same week, split in two
 * partial cohorts when the week straddles a shipped change.
 */

import type { Prisma } from '#prisma-lib/client';
import type { PeriodExpression } from './dashboard';

/**
 * Projects each creator's cohort (`week` and `period`) and the end of their first day
 * (`dayOneEnd`), the first 24 hours after account creation.
 */
export function cohortMemberStages(period: PeriodExpression): readonly Prisma.InputJsonObject[] {
  return [
    {
      $project: {
        createdAt: 1,
        week: weekOf('$createdAt'),
        period: period('$createdAt'),
        dayOneEnd: { $dateAdd: { startDate: '$createdAt', unit: 'day', amount: 1 } }
      }
    }
  ];
}

/**
 * Looks up into `as` the member's views or likes of their first day.
 * Each passes through the given stages.
 */
export function dayOneLookupStage(
  collection: 'views' | 'favorites',
  as: string,
  stages: readonly Prisma.InputJsonObject[] = [{ $project: { _id: 1 } }]
): Prisma.InputJsonObject {
  const dateField = collection == 'views' ? '$viewedAt' : '$favoritedAt';

  return {
    $lookup: {
      from: collection,
      localField: '_id',
      foreignField: 'creatorId',
      let: { createdAt: '$createdAt', dayOneEnd: '$dayOneEnd' },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [{ $gte: [dateField, '$$createdAt'] }, { $lt: [dateField, '$$dayOneEnd'] }]
            }
          }
        },
        ...stages
      ],
      as
    }
  };
}

/**
 * The expression dividing two sums, or null where the divisor is 0.
 */
export function ratioExpression(dividend: string, divisor: string): Prisma.InputJsonObject {
  return { $cond: [{ $gt: [divisor, 0] }, { $divide: [dividend, divisor] }, null] };
}

/**
 * Groups the members by cohort into a row of `week`, `period`, the cohort size (`creators`), and
 * the given metrics, computed from the group's accumulators.
 */
export function groupByCohortStages(
  accumulators: Prisma.InputJsonObject,
  metrics: Prisma.InputJsonObject
): readonly Prisma.InputJsonObject[] {
  return [
    {
      $group: {
        _id: { week: '$week', period: '$period' },
        creators: { $sum: 1 },
        ...accumulators
      }
    },
    { $project: { _id: 0, week: '$_id.week', period: '$_id.period', creators: 1, ...metrics } },
    { $sort: { week: 1, period: 1 } }
  ];
}

/**
 * The expression of the UTC week, starting on Monday, of a date.
 */
export function weekOf(date: string): Prisma.InputJsonObject {
  return { $dateTrunc: { date, unit: 'week', startOfWeek: 'monday' } };
}
