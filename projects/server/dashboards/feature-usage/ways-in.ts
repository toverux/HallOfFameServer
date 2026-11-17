/**
 * The cards on how players reach features and drive the slideshow, over the players whose events
 * reached the server in the last ended weeks.
 */

import type { Prisma } from '#prisma-lib/client';
import { isInLastWeeks, ratioExpression } from '../expressions';
import type { FeatureUsageCard } from './dashboard';
import { snapshotWeeks } from './settings';

/**
 * A place a feature opens from, as its event's `from` property reports it.
 */
interface EntryPoint {
  readonly feature: string;

  readonly event: string;

  readonly from: string;

  readonly label: string;
}

/**
 * The features' colors, those of Feature adoption.
 */
const featureColors: Readonly<Record<string, string>> = {
  'Creator dashboard': '#7172AD',
  'Screenshot details': '#98D9D9',
  'Web viewer': '#689636',
  'Mod page': '#C7B8E0'
};

const entryPoints: readonly EntryPoint[] = [
  {
    feature: 'Creator dashboard',
    event: 'dashboard_opened',
    from: 'menu',
    label: 'Dashboard, from the main menu'
  },
  {
    feature: 'Creator dashboard',
    event: 'dashboard_opened',
    from: 'mod_menu',
    label: 'Dashboard, from a city or the editor'
  },
  {
    feature: 'Creator dashboard',
    event: 'dashboard_opened',
    from: 'upload_panel',
    label: 'Dashboard, after an upload'
  },
  {
    feature: 'Creator dashboard',
    event: 'dashboard_opened',
    from: 'options',
    label: 'Dashboard, from the options'
  },
  {
    feature: 'Screenshot details',
    event: 'screenshot_details_opened',
    from: 'menu',
    label: 'Details, from the main menu'
  },
  {
    feature: 'Screenshot details',
    event: 'screenshot_details_opened',
    from: 'dashboard',
    label: 'Details, from the dashboard'
  },
  {
    feature: 'Web viewer',
    event: 'viewer_opened',
    from: 'menu',
    label: 'Web viewer, from the main menu'
  },
  {
    feature: 'Web viewer',
    event: 'viewer_opened',
    from: 'dashboard',
    label: 'Web viewer, from the dashboard'
  },
  {
    feature: 'Web viewer',
    event: 'viewer_link_copied',
    from: 'menu',
    label: 'Web viewer link copied'
  },
  {
    feature: 'Mod page',
    event: 'asset_mod_page_opened',
    from: 'controls',
    label: 'Mod page, from the menu controls'
  },
  {
    feature: 'Mod page',
    event: 'asset_mod_page_opened',
    from: 'details',
    label: 'Mod page, from the details'
  }
];

/**
 * Ways a player navigated the slideshow, each an expression over a `slideshow_navigated` event.
 */
const navigationInputs = [
  { label: 'On-screen buttons', matches: { $eq: ['$properties.via', 'button'] } },
  { label: 'Key bindings', matches: { $eq: ['$properties.via', 'action'] } },
  { label: 'A gamepad', matches: { $eq: ['$properties.device', 'gamepad'] } },
  { label: 'Went back a screenshot', matches: { $eq: ['$properties.direction', 'previous'] } }
] as const;

export const entryPointsCard: FeatureUsageCard = {
  name: 'Where players open features, last 4 weeks',
  description: `Players who opened each feature from each place in the last 4 ended weeks, a player counting once per place. It counts the players whose events reached the server, without the eligibility rule of Feature adoption.`,
  collection: 'usage_events',
  chart: {
    display: 'row',
    dimensions: ['entry', 'feature'],
    metric: 'players',
    stacking: 'stacked',
    height: 8,
    seriesColors: featureColors
  },
  pipeline: () => [
    ...windowEventStages(entryPoints.map(entry => entry.event)),
    {
      $group: {
        _id: '$creatorId',
        entries: { $addToSet: { $concat: ['$name', ':', { $toString: '$properties.from' }] } }
      }
    },
    {
      $group: {
        _id: null,
        ...Object.fromEntries(
          entryPoints.map((entry, index) => [
            `entry${index}`,
            { $sum: { $cond: [{ $in: [`${entry.event}:${entry.from}`, '$entries'] }, 1, 0] } }
          ])
        )
      }
    },
    {
      $project: {
        rows: entryPoints.map((entry, index) => ({
          entry: entry.label,
          feature: entry.feature,
          players: `$entry${index}`
        }))
      }
    },
    { $unwind: '$rows' },
    { $replaceWith: '$rows' }
  ]
};

export const navigationInputsCard: FeatureUsageCard = {
  name: 'Slideshow navigation inputs, last 4 weeks',
  description: `Share of the players who navigated the slideshow in the last 4 ended weeks who did so through each input at least once, and who went back to a previous screenshot. It counts the players whose events reached the server.`,
  collection: 'usage_events',
  chart: { display: 'row', dimensions: ['input'], metric: 'share', isPercent: true },
  pipeline: () => [
    ...windowEventStages(['slideshow_navigated']),
    {
      $group: {
        _id: '$creatorId',
        ...Object.fromEntries(
          navigationInputs.map((input, index) => [
            `input${index}`,
            { $max: { $cond: [input.matches, 1, 0] } }
          ])
        )
      }
    },
    {
      $group: {
        _id: null,
        players: { $sum: 1 },
        ...Object.fromEntries(
          navigationInputs.map((_, index) => [`input${index}`, { $sum: `$input${index}` }])
        )
      }
    },
    {
      $project: {
        rows: navigationInputs.map((input, index) => ({
          input: input.label,
          share: ratioExpression(`$input${index}`, '$players')
        }))
      }
    },
    { $unwind: '$rows' },
    { $replaceWith: '$rows' }
  ]
};

/**
 * Stages keeping the events of the given names that the server received in the last
 * {@link snapshotWeeks} ended weeks, debug builds left out.
 */
function windowEventStages(names: readonly string[]): Prisma.InputJsonObject[] {
  return [
    {
      $match: {
        isDebug: false,
        name: { $in: [...new Set(names)] },
        $expr: isInLastWeeks('$receivedAt', snapshotWeeks)
      }
    }
  ];
}
