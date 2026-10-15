import {
  cohortMemberStages,
  dayOneLookupStage,
  groupByCohortStages,
  ratioExpression
} from './cohort-stages';
import type { DashboardCard } from './dashboard';

/**
 * The share of the cohort's first-day views served by newcomer protection, labelled `newcomer`.
 */
export const dayOneNewcomerPicks: DashboardCard = {
  name: 'Day-1 newcomer picks',
  collection: 'creators',
  pipeline: period => [
    ...cohortMemberStages(period),
    dayOneLookupStage('views', 'views', [
      { $project: { isNewcomerPick: { $eq: ['$algorithm', 'newcomer'] } } }
    ]),
    ...groupByCohortStages(
      {
        views: { $sum: { $size: '$views' } },
        newcomerViews: {
          $sum: { $size: { $filter: { input: '$views', cond: '$$this.isNewcomerPick' } } }
        }
      },
      { newcomerShare: ratioExpression('$newcomerViews', '$views') }
    )
  ]
};
