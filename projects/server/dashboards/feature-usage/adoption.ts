import type { Prisma } from '#prisma-lib/client';
import { ratioExpression } from '../expressions';
import type { FeatureUsageCard } from './dashboard';
import {
  eligiblePlayersPerWeekStages,
  lastWeekStage,
  serverRowNames,
  sessionStages
} from './sessions';

/**
 * A feature as the adoption cards count it: touched by a player who sent any of its events.
 */
interface Feature {
  readonly label: string;

  readonly events: readonly string[];

  readonly color: string;
}

/**
 * The features, in the legend's order.
 * The tour is left out, as the mod shows it to every player rather than the player opening it.
 */
const features: readonly Feature[] = [
  { label: 'Slideshow navigation', events: ['slideshow_navigated'], color: '#509EE3' },
  { label: 'Like', events: [serverRowNames.liked], color: '#EF8C8C' },
  { label: 'More actions menu', events: ['more_actions_opened'], color: '#A989C5' },
  { label: 'Screenshot details', events: ['screenshot_details_opened'], color: '#98D9D9' },
  { label: 'Creator dashboard', events: ['dashboard_opened'], color: '#7172AD' },
  { label: 'Capture', events: ['capture_requested'], color: '#88BF4D' },
  { label: 'Upload', events: ['upload_started'], color: '#F2A86F' },
  { label: 'Save to disk', events: ['screenshot_saved'], color: '#F9D45C' },
  { label: 'Web viewer', events: ['viewer_opened', 'viewer_link_copied'], color: '#689636' },
  { label: 'Mod page', events: ['asset_mod_page_opened'], color: '#C7B8E0' },
  { label: 'Social links', events: ['social_link_opened'], color: '#E35850' }
];

/**
 * Sent by every eligible player's mod at each game load, so a player who has none had their events
 * lost.
 */
const launched = { label: 'Launched the mod', events: ['context_entered'] } as const;

export const eventCoverage: FeatureUsageCard = {
  name: 'Event coverage',
  description: `Share of last week's eligible players whose usage events reached the server, against the week before. It sits just under 100%, as a lost batch drops a player; a fall means the events stopped arriving, as from a tracking bug, and every other card undercounts with it.`,
  collection: 'usage_events',
  chart: { display: 'smartscalar', dimensions: ['week'], metric: 'share', isPercent: true },
  pipeline: () => adoptionStages([launched])
};

export const featureAdoptionPerWeek: FeatureUsageCard = {
  name: 'Feature adoption per week',
  description: `Share of the week's eligible players who used each feature at least once. Eligible players loaded the game that week with a mod version that sends usage statistics, and have not switched them off; a past week's figure moves when a player switches them off.`,
  collection: 'usage_events',
  chart: {
    display: 'line',
    dimensions: ['week', 'feature'],
    metric: 'share',
    isPercent: true,
    seriesColors: Object.fromEntries(features.map(feature => [feature.label, feature.color]))
  },
  pipeline: () => adoptionStages(features)
};

export const featureAdoptionLastWeek: FeatureUsageCard = {
  name: 'Feature adoption, last week',
  description: `Share of last week's eligible players who used each feature at least once, most used first. See Feature adoption per week for who is eligible.`,
  collection: 'usage_events',
  chart: { display: 'row', dimensions: ['feature'], metric: 'share', isPercent: true },
  pipeline: () => [...adoptionStages(features), lastWeekStage, { $sort: { share: -1 } }]
};

/**
 * Rows of `week`, `feature`, and `share`, every given feature each week, in the given order.
 */
function adoptionStages(
  counted: ReadonlyArray<Pick<Feature, 'label' | 'events'>>
): Prisma.InputJsonObject[] {
  return [
    ...sessionStages([...new Set(counted.flatMap(feature => feature.events))]),
    // Whether the session touched each feature, as 1 or 0.
    {
      $project: {
        creatorId: 1,
        week: 1,
        ...Object.fromEntries(
          counted.map((feature, index) => [
            `feature${index}`,
            {
              $cond: [{ $gt: [{ $add: feature.events.map(event => `$${event}`) }, 0] }, 1, 0]
            }
          ])
        )
      }
    },
    ...eligiblePlayersPerWeekStages(touchedFeatures(counted)),
    {
      $project: {
        _id: 0,
        week: '$_id',
        rows: counted.map((feature, index) => ({
          order: index,
          feature: feature.label,
          share: ratioExpression(`$feature${index}`, '$players')
        }))
      }
    },
    { $unwind: '$rows' },
    { $sort: { 'week': 1, 'rows.order': 1 } },
    { $project: { week: 1, feature: '$rows.feature', share: '$rows.share' } }
  ];
}

/**
 * The accumulators of whether any of a player's sessions touched each feature, as 1 or 0.
 */
function touchedFeatures(counted: readonly unknown[]): Prisma.InputJsonObject {
  return Object.fromEntries(
    counted.map((_, index) => [`feature${index}`, { $max: `$feature${index}` }])
  );
}
