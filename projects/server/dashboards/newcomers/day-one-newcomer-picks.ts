import { ratioExpression } from '../expressions';
import { cohortMemberStages, dayOneLookupStage, groupByCohortStages } from './cohort-stages';
import type { NewcomersCard } from './dashboard';

export const dayOneNewcomerPicks: NewcomersCard = {
  name: 'Day-1 newcomer picks',
  description: `Share of first-day views served by newcomer protection, which picks a newcomer's first screenshots among those ranked Gold or better.`,
  collection: 'creators',
  chart: {
    display: 'line',
    dimensions: ['week', 'period'],
    metric: 'newcomerShare',
    isPercent: true
  },
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
