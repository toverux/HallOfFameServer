/**
 * The Feature usage dashboard: which features players use, where the capture flow loses them, and
 * how often they come back, from the usage events the mod sends and the rows of each session; how
 * players set the mod up; and what they upload.
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
import { detailsTabsPerWeek } from './details-tabs';
import { menuOnlySessionsPerWeek, menuTimePerWeek } from './menu-time';
import { menuTourOutcomesPerWeek, uploadOutcomesPerWeek } from './outcomes';
import { firstReleaseWithCompleteEvents, firstReleaseWithEvents } from './sessions';
import {
  changedAnySetting,
  changedAnySettingByAccountAge,
  playersCounted,
  settingsChanged,
  usageStatisticsOff,
  weightsByDirection
} from './settings';
import {
  engagementByLanguage,
  everUploaded,
  gamepadConnected,
  legacyInterface,
  screensAndResolution
} from './setups';
import {
  dynamicResolutionForcedOff,
  firstTimeUploadersLastWeek,
  photoModeSettingsChanged,
  sceneCards,
  timeOfDaySet,
  upscalerForcedOff,
  uploadersLastWeek,
  uploadersPerWeek,
  uploadFormChoices,
  uploadsLastWeek,
  uploadsPerUploaderLastWeek
} from './uploads';
import { entryPointsCard, navigationInputsCard } from './ways-in';

const columnTitles = {
  week: 'Week',
  period: 'Period',
  feature: 'Feature',
  share: 'Players',
  step: 'Step',
  outcome: 'Outcome',
  tab: 'Tab',
  count: 'Count',
  uploadRate: 'Upload rate',
  players: 'Players',
  sessions: 'Sessions',
  views: 'Views',
  sessionsPerPlayer: 'Sessions per player',
  viewsPerSession: 'Views per session',
  entry: 'Entry point',
  input: 'Input',
  quartile: 'Quartile',
  minutes: 'Minutes',
  sessionShare: 'Sessions',
  setting: 'Setting',
  accountAge: 'Account age',
  language: 'Game language',
  algorithm: 'Algorithm',
  direction: 'Direction',
  screen: 'Screen',
  resolution: 'Screenshots',
  engagement: 'Engagement',
  uploads: 'Uploads',
  uploaders: 'Uploaders',
  kind: 'Uploader',
  choice: 'Choice',
  uploaderShare: 'Uploaders',
  uploadShare: 'Uploads',
  dayPhase: 'Time of day',
  season: 'Season',
  weather: 'Weather',
  theme: 'City theme',
  firstTimeUploaders: 'First-time uploaders',
  uploadsPerUploader: 'Uploads per uploader'
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
  columnTitles,
  dateColumns: ['week', 'period'],
  tabs: [
    {
      name: 'Features',
      introduction: [
        `**How to read this tab**`,
        `A session is one game launch: the usage events the mod sent, and the views, likes, and uploads its requests made. Weeks run Monday to Sunday (UTC) and show once ended, each session whole in the week it started; the headline numbers compare last week with the week before.`,
        `Players count when they ran mod ${firstReleaseWithEvents} or later that week and left usage statistics on; debug builds never count.`,
        `Upload outcomes per week and the Details window and tour section count the sessions whose events reached the server, from mod ${firstReleaseWithCompleteEvents} on, and Ways in the players whose events reached it in the last 4 ended weeks, all without that eligibility rule.`
      ].join('\n\n'),
      sections: [
        {
          heading: 'Last week',
          rows: [[activePlayers, sessionsPerPlayer, uploadRate, eventCoverage]]
        },
        { heading: 'Adoption', rows: [[featureAdoptionLastWeek, featureAdoptionPerWeek]] },
        {
          heading: 'Capture funnel',
          rows: [[captureFunnelLastWeek, captureFunnelPerWeek], [uploadOutcomesPerWeek]]
        },
        { heading: 'Ways in', rows: [[entryPointsCard, navigationInputsCard]] },
        {
          heading: 'Details window and tour',
          rows: [[detailsTabsPerWeek, menuTourOutcomesPerWeek]]
        },
        {
          heading: 'Depth',
          rows: [
            [activePlayersPerWeek, sessionsPerPlayerPerWeek, viewsPerSessionPerWeek],
            [menuTimePerWeek, menuOnlySessionsPerWeek]
          ]
        }
      ]
    },
    {
      name: 'Players',
      introduction: [
        `**How to read this tab**`,
        `A snapshot of the players who loaded the game with the mod in the last 4 ended weeks (Monday to Sunday, UTC), whatever their mod version or usage statistics toggle: their settings and setups as their mod last reported them, at each launch and each change. The server keeps no history of them, so a past snapshot cannot be read back.`,
        `A share counts the players whose mod version reports what it measures. Engagement by game language counts instead the players whose usage events reached the server.`
      ].join('\n\n'),
      sections: [
        {
          heading: 'Last 4 weeks',
          rows: [
            [
              playersCounted,
              everUploaded,
              changedAnySetting,
              usageStatisticsOff,
              legacyInterface,
              gamepadConnected
            ]
          ]
        },
        {
          heading: 'Settings',
          rows: [
            [settingsChanged, weightsByDirection],
            [changedAnySettingByAccountAge, screensAndResolution]
          ]
        },
        { heading: 'Languages', rows: [[engagementByLanguage]] }
      ]
    },
    {
      name: 'Uploads',
      introduction: [
        `**How to read this tab**`,
        `The screenshots the server stored, from every uploader whatever their mod version or usage statistics toggle; a deleted screenshot leaves them. Weeks run Monday to Sunday (UTC) and show once ended.`,
        `The captures section reads the scene and capture settings the mod records from 2026.5.0 on, over the last 12 ended weeks.`
      ].join('\n\n'),
      sections: [
        {
          heading: 'Last week',
          rows: [
            [
              uploadsLastWeek,
              uploadersLastWeek,
              firstTimeUploadersLastWeek,
              uploadsPerUploaderLastWeek
            ]
          ]
        },
        { heading: 'Uploaders', rows: [[uploadersPerWeek, uploadFormChoices]] },
        {
          heading: 'Captures',
          rows: [
            [timeOfDaySet, upscalerForcedOff, dynamicResolutionForcedOff],
            [photoModeSettingsChanged],
            [...sceneCards]
          ]
        }
      ]
    }
  ]
};
