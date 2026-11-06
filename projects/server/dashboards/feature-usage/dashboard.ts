/**
 * The Feature usage dashboard: which features players use, where the capture flow loses them, and
 * how often they come back, from the usage events the mod sends and the rows of each session.
 */

import type { Dashboard, DashboardCard } from '../dashboard';
import { eventCoverage, featureAdoptionLastWeek, featureAdoptionPerWeek } from './adoption';
import { captureFunnelLastWeek, captureFunnelPerWeek, uploadRate } from './capture-funnel';
import {
  activePlayers,
  activePlayersPerWeek,
  sessionsPerPlayer,
  sessionsPerPlayerPerWeek,
  viewsPerSessionPerWeek
} from './depth';
import { firstReleaseWithEvents } from './sessions';

const columnTitles = {
  week: 'Week',
  feature: 'Feature',
  share: 'Players',
  step: 'Step',
  count: 'Count',
  uploadRate: 'Upload rate',
  players: 'Players',
  sessions: 'Sessions',
  views: 'Views',
  sessionsPerPlayer: 'Sessions per player',
  viewsPerSession: 'Views per session'
} as const satisfies Record<string, string>;

/**
 * A column the pipelines output.
 */
export type Column = keyof typeof columnTitles;

/**
 * A card of the Feature usage dashboard, its pipeline taking no period.
 */
export type FeatureUsageCard = DashboardCard<Column>;

export const featureUsageDashboard: Dashboard<Column> = {
  name: 'Feature usage',
  introduction: [
    `**How to read this dashboard**`,
    `A session is one game launch: the usage events the mod sent, and the views, likes, and uploads its requests made. Weeks run Monday to Sunday (UTC) and show once ended, each session whole in the week it started; the headline numbers compare last week with the week before.`,
    `Players count when they ran mod ${firstReleaseWithEvents} or later that week and left usage statistics on; debug builds never count.`
  ].join('\n\n'),
  columnTitles,
  sections: [
    {
      heading: 'Last week',
      rows: [[activePlayers, sessionsPerPlayer, uploadRate, eventCoverage]]
    },
    { heading: 'Adoption', rows: [[featureAdoptionLastWeek, featureAdoptionPerWeek]] },
    { heading: 'Capture funnel', rows: [[captureFunnelLastWeek, captureFunnelPerWeek]] },
    {
      heading: 'Depth',
      rows: [[activePlayersPerWeek, sessionsPerPlayerPerWeek, viewsPerSessionPerWeek]]
    }
  ]
};
