import {
  cohortMemberStages,
  dayOneLookupStage,
  groupByCohortStages,
  ratioExpression
} from './cohort-stages';
import type { DashboardCard } from './dashboard';

export const dayOneLikeRate: DashboardCard = {
  name: 'Day-1 like rate',
  description: `Likes divided by views over each newcomer's first 24 hours. This is the main measure of whether newcomers see cities they like.`,
  collection: 'creators',
  chart: {
    display: 'line',
    dimensions: ['week', 'period'],
    metric: 'likeRate',
    isPercent: true
  },
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
