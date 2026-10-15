import { cohortMemberStages, groupByCohortStages } from './cohort-stages';
import type { DashboardCard } from './dashboard';

export const cohortSize: DashboardCard = {
  name: 'Cohort size',
  collection: 'creators',
  pipeline: period => [...cohortMemberStages(period), ...groupByCohortStages({}, {})]
};
