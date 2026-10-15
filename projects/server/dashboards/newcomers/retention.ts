import type { Prisma } from '#prisma-lib/client';
import { cohortMemberStages, groupByCohortStages } from './cohort-stages';
import type { DashboardCard } from './dashboard';

/**
 * Below it, a cohort's retention swings too far to read.
 */
const minCohortSize = 30;

export const dayOneRetention = retentionCard({
  metric: 'd1',
  start: 1,
  end: 2,
  description: `Share of each cohort that came back (a view or a game load) 24 to 48 hours after creating their account. It can be lower than D7 because its window is one day instead of a week.`
});

export const daySevenRetention = retentionCard({
  metric: 'd7',
  start: 7,
  end: 14,
  description: `Share of each cohort that came back (a view or a game load) between days 7 and 14 after creating their account.`
});

export const dayThirtyRetention = retentionCard({
  metric: 'd30',
  start: 30,
  end: 37,
  description: `Share of each cohort that came back (a view or a game load) between days 30 and 37 after creating their account.`
});

/**
 * A retention card, charting the share of each cohort that came back within a window.
 * The window is in days after account creation.
 * Each card charts one window, as a chart splitting its series by period draws one metric.
 */
function retentionCard(
  window: Readonly<{ metric: 'd1' | 'd7' | 'd30'; start: number; end: number; description: string }>
): DashboardCard {
  const { metric, end } = window;

  return {
    name: `${metric.toUpperCase()} retention`,
    description: `${window.description} A value appears once every member is past the end of the window, and only for cohorts of ${minCohortSize} players or more.`,
    collection: 'creators',
    chart: { display: 'line', dimensions: ['week', 'period'], metric, isPercent: true },
    pipeline: period => [
      ...cohortMemberStages(period),
      windowLookupStage('views', ['viewedAt'], window, 'views'),
      // A record's day lies within its first and last time seen, and a window spans a day or
      // more, so the record overlaps the window when one of those times falls in it.
      windowLookupStage('creator_activities', ['firstSeenAt', 'lastSeenAt'], window, 'records'),
      ...groupByCohortStages(
        {
          youngestCreatedAt: { $max: '$createdAt' },
          retained: {
            $sum: {
              $cond: [{ $gt: [{ $size: { $concatArrays: ['$views', '$records'] } }, 0] }, 1, 0]
            }
          }
        },
        {
          [metric]: {
            $cond: [
              { $lte: [daysAfter('$youngestCreatedAt', end), '$$NOW'] },
              { $divide: ['$retained', '$creators'] },
              null
            ]
          }
        }
      ),
      { $match: { creators: { $gte: minCohortSize } } }
    ]
  };
}

/**
 * Looks up into `as` one of the member's records of a collection with a time in the window,
 * matched by `creatorId`.
 */
function windowLookupStage(
  collection: 'views' | 'creator_activities',
  fields: readonly string[],
  window: Readonly<{ start: number; end: number }>,
  as: string
): Prisma.InputJsonObject {
  return {
    $lookup: {
      from: collection,
      localField: '_id',
      foreignField: 'creatorId',
      let: {
        start: daysAfter('$createdAt', window.start),
        end: daysAfter('$createdAt', window.end)
      },
      pipeline: [
        {
          $match: {
            $expr: {
              $or: fields.map(field => ({
                $and: [{ $gte: [`$${field}`, '$$start'] }, { $lt: [`$${field}`, '$$end'] }]
              }))
            }
          }
        },
        { $limit: 1 },
        { $project: { _id: 1 } }
      ],
      as
    }
  };
}

function daysAfter(date: string, days: number): Prisma.InputJsonObject {
  return { $dateAdd: { startDate: date, unit: 'day', amount: days } };
}
