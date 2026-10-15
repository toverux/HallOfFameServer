import type { Prisma } from '#prisma-lib/client';
import { cohortMemberStages, groupByCohortStages } from './cohort-stages';
import type { DashboardCard } from './dashboard';

// oxlint-disable-next-line no-magic-numbers - the ages of D1, D7, and D30
const retentionDays = [1, 7, 30] as const;

/**
 * D1, D7, and D30: the share of the cohort whose last activity, a view or a game load, came at
 * least that many days after account creation.
 * A share stays empty until every member is that many days old, so a young cohort never looks
 * like it churned.
 */
export const retention: DashboardCard = {
  name: 'Retention',
  collection: 'creators',
  pipeline: period => [
    ...cohortMemberStages(period),
    lastLookupStage('views', 'viewedAt', 'lastView'),
    // The latest day holds the latest time seen.
    lastLookupStage('creator_activities', 'day', 'lastActivityRecord'),
    {
      $set: {
        // `$max` skips a missing operand, and is null for a member with neither.
        lastActivity: {
          $max: [{ $first: '$lastView.viewedAt' }, { $first: '$lastActivityRecord.lastSeenAt' }]
        }
      }
    },
    ...groupByCohortStages(
      {
        youngestCreatedAt: { $max: '$createdAt' },
        ...Object.fromEntries(
          retentionDays.map(days => [
            `retained${days}`,
            // A null last activity compares lower than any date.
            { $sum: { $cond: [{ $gte: ['$lastActivity', daysAfter('$createdAt', days)] }, 1, 0] } }
          ])
        )
      },
      Object.fromEntries(
        retentionDays.map(days => [
          `d${days}`,
          {
            $cond: [
              { $lte: [daysAfter('$youngestCreatedAt', days), '$$NOW'] },
              { $divide: [`$retained${days}`, '$creators'] },
              null
            ]
          }
        ])
      )
    )
  ]
};

/**
 * Looks up into `as` the member's latest record of a collection, by a field indexed with
 * `creatorId`.
 */
function lastLookupStage(collection: string, field: string, as: string): Prisma.InputJsonObject {
  return {
    $lookup: {
      from: collection,
      localField: '_id',
      foreignField: 'creatorId',
      pipeline: [{ $sort: { [field]: -1 } }, { $limit: 1 }],
      as
    }
  };
}

function daysAfter(date: string, days: number): Prisma.InputJsonObject {
  return { $dateAdd: { startDate: date, unit: 'day', amount: days } };
}
