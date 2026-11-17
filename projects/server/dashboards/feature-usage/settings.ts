/**
 * The Players tab's cards on settings, from the metadata each player's mod last reported.
 * The mod reports its settings at each launch and each change, and the server merges them into the
 * creator's metadata, so it holds their current values, with no history.
 */

import type { Prisma } from '#prisma-lib/client';
import { isInLastWeeks, ratioExpression } from '../expressions';
import type { FeatureUsageCard } from './dashboard';

/**
 * Ended weeks a snapshot card counts the players of.
 */
export const snapshotWeeks = 4;

const daysPerWeek = 7;

/**
 * A setting of the mod's options as it reports it, under its English label.
 */
interface Setting {
  readonly label: string;

  readonly key: string;

  /**
   * The current release's default.
   */
  readonly defaultValue: boolean | number | string;

  /**
   * For a weight whose default changed across releases, its position in each set of
   * {@link historicalWeights}: the player's default is then that of the set their options started
   * from.
   */
  readonly baselineIndex?: number;
}

/**
 * A weight of a slideshow algorithm, under the label of its option.
 */
interface Weight extends Setting {
  readonly defaultValue: number;
}

/**
 * The default weight of Popular and Trending in every release.
 */
const steadyDefaultWeight = 10;

const weights: readonly Weight[] = [
  { label: 'Popular', key: 'popularScreenshotWeight', defaultValue: steadyDefaultWeight },
  { label: 'Trending', key: 'trendingScreenshotWeight', defaultValue: steadyDefaultWeight },
  { label: 'Recent', key: 'recentScreenshotWeight', defaultValue: 10, baselineIndex: 0 },
  {
    label: 'Forgotten Ones',
    key: 'archeologistScreenshotWeight',
    defaultValue: 0,
    baselineIndex: 1
  },
  { label: 'Random', key: 'randomScreenshotWeight', defaultValue: 5, baselineIndex: 2 },
  {
    label: 'Community Supporters',
    key: 'supporterScreenshotWeight',
    defaultValue: 1,
    baselineIndex: 3
  }
];

/**
 * The weights of Recent, Forgotten Ones, Random, and Community Supporters each release shipped as
 * defaults, newest first: the options file keeps the defaults of the release that wrote it, so a
 * player who installed the mod before a change still holds the older defaults.
 * Popular and Trending have kept {@link steadyDefaultWeight} throughout.
 */
const historicalWeights: Prisma.InputJsonArray = [
  // oxlint-disable-next-line no-magic-numbers - the weights as each release shipped them
  [10, 0, 5, 1],
  // oxlint-disable-next-line no-magic-numbers - the weights as each release shipped them
  [5, 2, 2, 2],
  // oxlint-disable-next-line no-magic-numbers - the weights as each release shipped them
  [5, 5, 2, 2]
];

/**
 * The settings of the options page, ordered as it lists them.
 * The screenshot resolution is left out, as its default follows the screen it was first read on:
 * Screens and capture resolution shows it.
 */
const settings: readonly Setting[] = [
  { label: 'Enable main menu integration', key: 'enableMainMenuSlideshow', defaultValue: true },
  {
    label: 'Show latest image on the loading screen',
    key: 'enableLoadingScreenBackground',
    defaultValue: true
  },
  { label: 'Show featured assets', key: 'showFeaturedAsset', defaultValue: true },
  { label: 'Show creators’ social links', key: 'showCreatorSocials', defaultValue: true },
  { label: 'Show city milestone and population', key: 'showCityInfo', defaultValue: true },
  { label: 'Show view count', key: 'showViewCount', defaultValue: false },
  { label: 'Show screenshot details', key: 'showScreenshotDetails', defaultValue: true },
  { label: 'Names translation mode', key: 'namesTranslationMode', defaultValue: 'translate' },
  ...weights.map(weight => ({ ...weight, label: `Weight: ${weight.label}` })),
  { label: 'Minimum time before showing again', key: 'viewMaxAge', defaultValue: 60 },
  { label: 'Save a local screenshot file', key: 'createLocalScreenshot', defaultValue: true },
  {
    label: 'Send usage statistics and error reports',
    key: 'sendUsageStatistics',
    defaultValue: true
  }
];

/**
 * Bands of account age, by the account's creation before the window's end, youngest first.
 */
const accountAges = [
  { label: 'Joined in the last 4 weeks', maxDays: daysPerWeek * snapshotWeeks },
  { label: '4 weeks to 6 months', maxDays: 182 },
  { label: '6 months to a year', maxDays: 365 },
  { label: 'Over a year', maxDays: undefined }
] as const;

/**
 * How a player set a weight away from its default, exclusive, in the legend's order.
 */
const weightDirections = [
  { label: 'Raised', color: '#88BF4D' },
  { label: 'Lowered', color: '#F2A86F' },
  { label: 'Turned off', color: '#949AAB' }
] as const;

export const playersCounted: FeatureUsageCard = {
  name: 'Players counted, last 4 weeks',
  description: `Players who loaded the game with the mod in the last 4 ended weeks, whatever their mod version or usage statistics toggle. The Players tab's settings and setups are theirs, as their mod last reported them.`,
  collection: 'creator_activities',
  chart: { display: 'scalar', dimensions: ['players'], metric: 'players' },
  pipeline: () => [...activePlayersStages(), { $count: 'players' }]
};

export const changedAnySetting: FeatureUsageCard = {
  name: 'Changed any setting',
  description: `Share of the players counted whose options hold at least one setting away from its default, among those listed in Settings changed from their default.`,
  collection: 'creator_activities',
  chart: { display: 'scalar', dimensions: ['share'], metric: 'share', isPercent: true },
  pipeline: () => [
    ...activePlayersStages(),
    { $project: { changed: anyChangedExpression() } },
    { $group: { _id: null, players: { $sum: 1 }, changed: { $sum: '$changed' } } },
    { $project: { _id: 0, share: ratioExpression('$changed', '$players') } }
  ]
};

export const usageStatisticsOff: FeatureUsageCard = {
  name: 'Usage statistics switched off',
  description: `Share of the players counted whose mod reports the "Send usage statistics and error reports" toggle, from mod 2026.6.0 on, who switched it off. Their events, sessions, and error reports never reach the server.`,
  collection: 'creator_activities',
  chart: { display: 'scalar', dimensions: ['share'], metric: 'share', isPercent: true },
  pipeline: () => metadataShareStages('sendUsageStatistics', false)
};

export const settingsChanged: FeatureUsageCard = {
  name: 'Settings changed from their default, last 4 weeks',
  description: `Share of the players counted whose options hold each setting away from its default, most changed first. Each share counts the players whose mod version reports the setting. A weight compares with the defaults of the release the player's options most likely started from, as Slideshow weights changed tells.`,
  collection: 'creator_activities',
  chart: { display: 'row', dimensions: ['setting'], metric: 'share', isPercent: true, height: 10 },
  pipeline: () => [
    ...activePlayersStages(),
    {
      $project: Object.fromEntries(
        settings.map((setting, index) => [`setting${index}`, changedExpression(setting)] as const)
      )
    },
    {
      $group: {
        _id: null,
        ...Object.fromEntries<Prisma.InputJsonObject>(
          settings.flatMap((_, index) => [
            [`changed${index}`, { $sum: `$setting${index}` }],
            [`reporting${index}`, { $sum: { $cond: [{ $eq: [`$setting${index}`, null] }, 0, 1] } }]
          ])
        )
      }
    },
    {
      $project: {
        rows: settings.map((setting, index) => ({
          setting: setting.label,
          share: ratioExpression(`$changed${index}`, `$reporting${index}`)
        }))
      }
    },
    { $unwind: '$rows' },
    { $replaceWith: '$rows' },
    { $sort: { share: -1, setting: 1 } }
  ]
};

export const changedAnySettingByAccountAge: FeatureUsageCard = {
  name: 'Changed any setting, by account age',
  description: `Share of the players counted who changed at least one setting, by how long before the window's end their account was created. Players who have spent longer with the mod have had more time to explore its options.`,
  collection: 'creator_activities',
  chart: { display: 'row', dimensions: ['accountAge'], metric: 'share', isPercent: true },
  pipeline: () => [
    ...activePlayersStages(),
    {
      $project: {
        changed: anyChangedExpression(),
        ageInDays: {
          $dateDiff: { startDate: '$createdAt', endDate: windowEnd(), unit: 'day' }
        }
      }
    },
    {
      $group: {
        _id: {
          $switch: {
            branches: accountAges
              .filter(age => age.maxDays != null)
              .map((age, index) => ({
                case: { $lt: ['$ageInDays', age.maxDays] },
                // oxlint-disable-next-line unicorn/no-thenable - a $switch branch, never awaited
                then: index
              })),
            default: accountAges.length - 1
          }
        },
        players: { $sum: 1 },
        changed: { $sum: '$changed' }
      }
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        accountAge: { $arrayElemAt: [accountAges.map(age => age.label), '$_id'] },
        share: ratioExpression('$changed', '$players')
      }
    }
  ]
};

export const weightsByDirection: FeatureUsageCard = {
  name: 'Slideshow weights changed, last 4 weeks',
  description: `Players counted who set each slideshow algorithm's weight away from its default: raised above it, lowered without reaching 0, or turned off at 0. Defaults changed across releases, and a player's options keep those of the release they installed: each player's weights compare with the release defaults they share the most values with, the newest on a tie.`,
  collection: 'creator_activities',
  chart: {
    display: 'row',
    dimensions: ['algorithm', 'direction'],
    metric: 'players',
    stacking: 'stacked',
    seriesColors: Object.fromEntries(
      weightDirections.map(direction => [direction.label, direction.color])
    )
  },
  pipeline: () => [
    ...activePlayersStages(),
    {
      $project: {
        _id: 0,
        weights: weights.map((weight, order) => ({
          order,
          algorithm: weight.label,
          direction: directionExpression(weight)
        }))
      }
    },
    { $unwind: '$weights' },
    { $match: { 'weights.direction': { $ne: null } } },
    {
      $group: {
        _id: { order: '$weights.order', direction: '$weights.direction' },
        algorithm: { $first: '$weights.algorithm' },
        players: { $sum: 1 }
      }
    },
    { $sort: { '_id.order': 1, '_id.direction': 1 } },
    {
      $project: {
        _id: 0,
        algorithm: 1,
        direction: {
          $arrayElemAt: [weightDirections.map(direction => direction.label), '$_id.direction']
        },
        players: 1
      }
    }
  ]
};

/**
 * Stages on `creator_activities` yielding the creator of each player who loaded the game with the
 * mod in the last {@link snapshotWeeks} ended weeks, with their `metadata` and `createdAt`.
 * Starting from the activities, indexed by day, reads only the window's players.
 */
export function activePlayersStages(): Prisma.InputJsonObject[] {
  return [
    { $match: { $expr: isInLastWeeks('$day', snapshotWeeks) } },
    { $group: { _id: '$creatorId' } },
    {
      $lookup: {
        from: 'creators',
        localField: '_id',
        foreignField: '_id',
        as: 'creator',
        pipeline: [{ $project: { metadata: 1, locale: 1, createdAt: 1 } }]
      }
    },
    { $unwind: '$creator' },
    { $replaceWith: '$creator' }
  ];
}

/**
 * Stages on `creator_activities` yielding one row of `share`: the players counted whose metadata
 * holds the given value under the key, among those whose mod reports it.
 */
export function metadataShareStages(
  key: string,
  value: boolean | number | string
): Prisma.InputJsonObject[] {
  return [
    ...activePlayersStages(),
    { $match: { [`metadata.${key}`]: { $exists: true } } },
    {
      $group: {
        _id: null,
        players: { $sum: 1 },
        matching: { $sum: { $cond: [{ $eq: [`$metadata.${key}`, value] }, 1, 0] } }
      }
    },
    { $project: { _id: 0, share: ratioExpression('$matching', '$players') } }
  ];
}

/**
 * The expression of whether a player's setting is away from its default, as 1 or 0, or null when
 * their mod does not report it.
 */
function changedExpression(setting: Setting): Prisma.InputJsonObject {
  const value = `$metadata.${setting.key}`;

  return {
    $cond: [
      { $eq: [{ $type: value }, 'missing'] },
      null,
      { $cond: [{ $eq: [value, defaultExpression(setting)] }, 0, 1] }
    ]
  };
}

/**
 * The expression of whether a player changed any setting, as 1 or 0.
 */
function anyChangedExpression(): Prisma.InputJsonObject {
  return { $max: [0, ...settings.map(setting => changedExpression(setting))] };
}

/**
 * The expression of the index in {@link weightDirections} of how a weight left its default, or null
 * where it holds it or the mod does not report it.
 */
function directionExpression(weight: Weight): Prisma.InputJsonObject {
  const value = `$metadata.${weight.key}`;

  const defaultValue = defaultExpression(weight);

  return {
    $cond: [
      { $or: [{ $eq: [{ $type: value }, 'missing'] }, { $eq: [value, defaultValue] }] },
      null,
      { $cond: [{ $gt: [value, defaultValue] }, 0, { $cond: [{ $gt: [value, 0] }, 1, 2] }] }
    ]
  };
}

/**
 * The expression of a setting's default for the player: for a weight whose default changed, that of
 * the set of {@link historicalWeights} the player's weights share the most values with, the newest
 * on a tie, as the player most likely started from it.
 */
function defaultExpression(setting: Setting): Prisma.InputJsonValue {
  if (setting.baselineIndex == null) {
    return setting.defaultValue;
  }

  const values = weights
    .filter(weight => weight.baselineIndex != null)
    .map(weight => `$metadata.${weight.key}`);

  const baseline = {
    $let: {
      vars: {
        matches: {
          $map: {
            input: historicalWeights,
            as: 'set',
            in: {
              $size: {
                $filter: {
                  input: { $range: [0, values.length] },
                  as: 'index',
                  cond: {
                    $eq: [
                      { $arrayElemAt: ['$$set', '$$index'] },
                      { $arrayElemAt: [values, '$$index'] }
                    ]
                  }
                }
              }
            }
          }
        }
      },
      in: {
        $arrayElemAt: [historicalWeights, { $indexOfArray: ['$$matches', { $max: '$$matches' }] }]
      }
    }
  };

  return { $arrayElemAt: [baseline, setting.baselineIndex] };
}

/**
 * The expression of the Monday ending the snapshot window, the start of the week in progress.
 */
function windowEnd(): Prisma.InputJsonObject {
  return { $dateTrunc: { date: '$$NOW', unit: 'week', startOfWeek: 'monday' } };
}
