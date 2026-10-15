import {
  cohortMemberStages,
  dayOneLookupStage,
  groupByCohortStages,
  ratioExpression
} from './cohort-stages';
import type { DashboardCard } from './dashboard';

/**
 * The cohort's likes over its views, both in its members' first day: the primary metric of
 * whether newcomers see something they like.
 */
export const dayOneLikeRate: DashboardCard = {
  name: 'Day-1 like rate',
  collection: 'creators',
  pipeline: period => [
    ...cohortMemberStages(period),
    dayOneLookupStage('views', 'views'),
    dayOneLookupStage('favorites', 'likes'),
    ...groupByCohortStages(
      { views: { $sum: { $size: '$views' } }, likes: { $sum: { $size: '$likes' } } },
      { likeRate: ratioExpression('$likes', '$views') }
    )
  ]
};
