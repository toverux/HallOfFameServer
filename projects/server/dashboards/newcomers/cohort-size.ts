import { cohortMemberStages, groupByCohortStages } from './cohort-stages';
import type { DashboardCard } from './dashboard';

export const cohortSize: DashboardCard = {
  name: 'Cohort size',
  description: `New accounts per week. A week that straddles a shipped change splits into two bars.`,
  collection: 'creators',
  chart: { display: 'bar', dimensions: ['week', 'period'], metric: 'creators', isStacked: true },
  pipeline: period => [...cohortMemberStages(period), ...groupByCohortStages({}, {})]
};
