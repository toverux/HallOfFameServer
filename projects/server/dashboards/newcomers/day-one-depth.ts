import { cohortMemberStages, dayOneLookupStage, groupByCohortStages } from './cohort-stages';
import type { DashboardCard } from './dashboard';

/**
 * The median number of screenshots the cohort's members viewed in their first day, 0 for those who
 * viewed none: catches a change that makes newcomers leave sooner.
 */
export const dayOneDepth: DashboardCard = {
  name: 'Day-1 depth',
  collection: 'creators',
  pipeline: period => [
    ...cohortMemberStages(period),
    dayOneLookupStage('views', 'views'),
    ...groupByCohortStages(
      { depth: { $median: { input: { $size: '$views' }, method: 'approximate' } } },
      { depth: 1 }
    )
  ]
};
