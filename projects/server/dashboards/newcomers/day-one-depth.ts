import { cohortMemberStages, dayOneLookupStage, groupByCohortStages } from './cohort-stages';
import type { DashboardCard } from './dashboard';

export const dayOneDepth: DashboardCard = {
  name: 'Day-1 depth',
  description: `Median number of screenshots a newcomer viewed in their first 24 hours, with 0 for those who viewed none. A drop means newcomers leave sooner.`,
  collection: 'creators',
  chart: { display: 'line', dimensions: ['week', 'period'], metric: 'depth' },
  pipeline: period => [
    ...cohortMemberStages(period),
    dayOneLookupStage('views', 'views'),
    ...groupByCohortStages(
      { depth: { $median: { input: { $size: '$views' }, method: 'approximate' } } },
      { depth: 1 }
    )
  ]
};
