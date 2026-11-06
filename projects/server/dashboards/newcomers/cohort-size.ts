import { cohortMemberStages, groupByCohortStages } from './cohort-stages';
import type { NewcomersCard } from './dashboard';

export const cohortSize: NewcomersCard = {
  name: 'Cohort size',
  description: `New accounts per week. A week that straddles a shipped change splits into two bars.`,
  collection: 'creators',
  chart: { display: 'bar', dimensions: ['week', 'period'], metric: 'creators', isStacked: true },
  pipeline: period => [...cohortMemberStages(period), ...groupByCohortStages({}, {})]
};
