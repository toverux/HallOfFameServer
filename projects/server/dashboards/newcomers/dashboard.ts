/**
 * The Newcomers dashboard: how newcomers' first day, retention, and the daily actives move with
 * each shipped change.
 */

import type { Dashboard, DashboardCard } from '../dashboard';
import { cohortSize } from './cohort-size';
import { dailyActives } from './daily-actives';
import { dailyActivesByModVersion } from './daily-actives-by-mod-version';
import { dayOneDepth } from './day-one-depth';
import { dayOneLikeRate } from './day-one-like-rate';
import { dayOneNewcomerPicks } from './day-one-newcomer-picks';
import { dayOneQualityServed } from './day-one-quality-served';
import { likeRateByAlgorithm } from './like-rate-by-algorithm';
import { dayOneRetention, daySevenRetention, dayThirtyRetention } from './retention';
import { shippedChanges } from './shipped-changes';

const columnTitles = {
  week: 'Week',
  day: 'Day',
  period: 'Period',
  creators: 'Players',
  views: 'Views',
  likeRate: 'Like rate',
  depth: 'Median views',
  qualityServed: 'Gold or better',
  newcomerShare: 'Newcomer picks',
  d1: 'D1',
  d7: 'D7',
  d30: 'D30',
  modVersion: 'Mod version',
  algorithm: 'Algorithm',
  series: 'Algorithm, period'
} as const satisfies Record<string, string>;

/**
 * A column the pipelines output.
 */
export type Column = keyof typeof columnTitles;

/**
 * A card of the Newcomers dashboard.
 */
export type NewcomersCard = DashboardCard<Column>;

export const newcomersDashboard: Dashboard<Column> = {
  name: 'Newcomers',
  columnTitles,
  shippedChanges,
  dateColumns: ['week', 'day'],
  tabs: [
    {
      name: 'Newcomers',
      introduction: [
        `**How to read this dashboard**`,
        `Newcomers are grouped into cohorts by the UTC week (Monday to Sunday) in which they created their account. Day 1 is a newcomer's first 24 hours. Cohorts start with the week of November 4, 2024, after the mod's launch weeks.`,
        `Each chart splits its series at every shipped change, except Daily actives by mod version, whose series are releases. Wait for about four cohorts on each side of a change before reading it, and check the cohort sizes.`
      ].join('\n\n'),
      sections: [
        {
          heading: 'First day',
          rows: [[dayOneLikeRate], [dayOneQualityServed, dayOneDepth, dayOneNewcomerPicks]]
        },
        {
          heading: 'Cohorts',
          rows: [[cohortSize], [dayOneRetention, daySevenRetention, dayThirtyRetention]]
        },
        { heading: 'Daily actives', rows: [[dailyActives, dailyActivesByModVersion]] },
        { heading: 'Algorithms', rows: [[likeRateByAlgorithm]] }
      ]
    }
  ]
};
