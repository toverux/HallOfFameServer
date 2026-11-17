/**
 * The Players tab's cards on the players' setups and languages.
 */

import type { Prisma } from '#prisma-lib/client';
import { isInLastWeeks, ratioExpression } from '../expressions';
import type { FeatureUsageCard } from './dashboard';
import { activePlayersStages, metadataShareStages, snapshotWeeks } from './settings';

/**
 * Screen classes, in the legend's order.
 * Every class but the first gets 4K screenshots by default: the mod picks 4K for a screen of more
 * pixels than 1920 by 1080.
 */
const screenClasses = ['Up to 1080p', 'Above 1080p, below 4K', 'Ultrawide', '4K or more'] as const;

/**
 * The width to height ratio from which a screen counts as ultrawide, 21:9 and wider.
 */
const ultrawideRatio = 2.1;

// oxlint-disable-next-line no-magic-numbers - the pixels of a Full HD screen
const fullHdPixels = 1920 * 1080;

// oxlint-disable-next-line no-magic-numbers - the pixels of a 4K UHD screen
const ultraHdPixels = 3840 * 2160;

const resolutions = [
  { label: 'Full HD screenshots', value: 'fhd', color: '#98D9D9' },
  { label: '4K screenshots', value: '4k', color: '#509EE3' }
] as const;

/**
 * Game languages with a segment of their own, the others falling in Other languages.
 */
const languages = [
  { label: 'English', locale: 'en-US' },
  { label: 'Chinese (Simplified)', locale: 'zh-HANS' }
] as const;

/**
 * What a player did in the window, from the server rows or the events, in the legend's order.
 */
const engagements = [
  { label: 'Liked a screenshot', key: 'liked', color: '#EF8C8C' },
  { label: 'Navigated the slideshow', key: 'navigated', color: '#509EE3' },
  { label: 'Uploaded a screenshot', key: 'uploaded', color: '#F2A86F' }
] as const;

export const legacyInterface: FeatureUsageCard = {
  name: 'Legacy interface',
  description: `Share of the players counted who play with the game's legacy interface style, which the mod's menu and windows must also suit.`,
  collection: 'creator_activities',
  chart: { display: 'scalar', dimensions: ['share'], metric: 'share', isPercent: true },
  pipeline: () => metadataShareStages('useLegacyInterface', true)
};

export const gamepadConnected: FeatureUsageCard = {
  name: 'Gamepad connected',
  description: `Share of the players counted who had a gamepad connected when the mod last reported, among those whose mod version reports it. Slideshow navigation inputs tells whether they navigate with it.`,
  collection: 'creator_activities',
  chart: { display: 'scalar', dimensions: ['share'], metric: 'share', isPercent: true },
  pipeline: () => metadataShareStages('isGamepadConnected', true)
};

export const screensAndResolution: FeatureUsageCard = {
  name: 'Screens and capture resolution, last 4 weeks',
  description: `Players counted by the class of their screen, split by the resolution of the screenshots they load. Ultrawide screens are at least 2.1 times as wide as tall. The mod defaults to 4K screenshots for any screen of more pixels than 1920 by 1080, so a Full HD share outside the first class is mostly players who changed it, or who installed the mod before that default.`,
  collection: 'creator_activities',
  chart: {
    display: 'row',
    dimensions: ['screen', 'resolution'],
    metric: 'players',
    stacking: 'stacked',
    seriesColors: Object.fromEntries(resolutions.map(item => [item.label, item.color]))
  },
  pipeline: () => [
    ...activePlayersStages(),
    {
      $match: {
        'metadata.screenWidth': { $gt: 0 },
        'metadata.screenHeight': { $gt: 0 },
        'metadata.screenshotResolution': { $in: resolutions.map(item => item.value) }
      }
    },
    {
      $group: {
        _id: {
          screen: screenClassExpression(),
          resolution: {
            $indexOfArray: [resolutions.map(item => item.value), '$metadata.screenshotResolution']
          }
        },
        players: { $sum: 1 }
      }
    },
    { $sort: { '_id.screen': 1, '_id.resolution': 1 } },
    {
      $project: {
        _id: 0,
        screen: { $arrayElemAt: [[...screenClasses], '$_id.screen'] },
        resolution: { $arrayElemAt: [resolutions.map(item => item.label), '$_id.resolution'] },
        players: 1
      }
    }
  ]
};

export const engagementByLanguage: FeatureUsageCard = {
  name: 'Engagement by game language, last 4 weeks',
  description: `Share of the players who sent usage events in the last 4 ended weeks who liked a screenshot, navigated the slideshow, and uploaded a screenshot then, by the language their game runs in. Every share counts over those players alone, leaving out the players on mod versions older than 2026.6.0 or with usage statistics off, so the three compare.`,
  collection: 'usage_events',
  chart: {
    display: 'row',
    dimensions: ['language', 'engagement'],
    metric: 'share',
    isPercent: true,
    seriesColors: Object.fromEntries(engagements.map(item => [item.label, item.color]))
  },
  pipeline: () => engagementStages()
};

/**
 * Rows of `language`, its label carrying its player count, `engagement`, and `share`, languages in
 * {@link languages}'s order then the others.
 * Each source groups its rows by player before the union, so one lookup per player reads their
 * language.
 */
function engagementStages(): Prisma.InputJsonObject[] {
  const inWindow = (date: string): Prisma.InputJsonObject => ({
    $match: { $expr: isInLastWeeks(date, snapshotWeeks) }
  });

  return [
    { $match: { isDebug: false } },
    inWindow('$receivedAt'),
    {
      $group: {
        _id: '$creatorId',
        sentEvents: { $max: 1 },
        navigated: { $max: { $cond: [{ $eq: ['$name', 'slideshow_navigated'] }, 1, 0] } }
      }
    },
    {
      $unionWith: {
        coll: 'favorites',
        pipeline: [inWindow('$favoritedAt'), { $group: { _id: '$creatorId', liked: { $max: 1 } } }]
      }
    },
    {
      $unionWith: {
        coll: 'screenshots',
        pipeline: [inWindow('$createdAt'), { $group: { _id: '$creatorId', uploaded: { $max: 1 } } }]
      }
    },
    {
      $group: {
        _id: '$_id',
        sentEvents: { $max: '$sentEvents' },
        ...Object.fromEntries(engagements.map(item => [item.key, { $max: `$${item.key}` }]))
      }
    },
    { $match: { sentEvents: 1 } },
    {
      $lookup: {
        from: 'creators',
        localField: '_id',
        foreignField: '_id',
        as: 'creator',
        pipeline: [{ $project: { _id: 0, locale: 1 } }]
      }
    },
    {
      $group: {
        // The others, at -1, sort last as Other languages.
        _id: {
          $let: {
            vars: {
              index: {
                $indexOfArray: [
                  languages.map(language => language.locale),
                  { $first: '$creator.locale' }
                ]
              }
            },
            in: { $cond: [{ $eq: ['$$index', -1] }, languages.length, '$$index'] }
          }
        },
        players: { $sum: 1 },
        ...Object.fromEntries(
          engagements.map(item => [item.key, { $sum: { $ifNull: [`$${item.key}`, 0] } }])
        )
      }
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        rows: engagements.map((item, order) => ({
          order,
          language: {
            $concat: [
              {
                $arrayElemAt: [
                  [...languages.map(language => language.label), 'Other languages'],
                  '$_id'
                ]
              },
              ', ',
              { $toString: '$players' },
              ' players'
            ]
          },
          engagement: item.label,
          share: ratioExpression(`$${item.key}`, '$players')
        }))
      }
    },
    { $unwind: '$rows' },
    { $replaceWith: '$rows' },
    { $project: { order: 0 } }
  ];
}

/**
 * The expression of the index in {@link screenClasses} of a player's screen.
 */
function screenClassExpression(): Prisma.InputJsonObject {
  const width = '$metadata.screenWidth';

  const height = '$metadata.screenHeight';

  const pixels = { $multiply: [width, height] };

  const classIndex = (name: (typeof screenClasses)[number]): number => screenClasses.indexOf(name);

  return {
    $cond: [
      { $gte: [{ $divide: [width, height] }, ultrawideRatio] },
      classIndex('Ultrawide'),
      {
        $cond: [
          { $lte: [pixels, fullHdPixels] },
          classIndex('Up to 1080p'),
          {
            $cond: [
              { $lt: [pixels, ultraHdPixels] },
              classIndex('Above 1080p, below 4K'),
              classIndex('4K or more')
            ]
          }
        ]
      }
    ]
  };
}

export const everUploaded: FeatureUsageCard = {
  name: 'Ever uploaded',
  description: `Share of the players counted who have uploaded at least one screenshot that the Hall of Fame still holds, at any time.`,
  collection: 'creator_activities',
  chart: { display: 'scalar', dimensions: ['share'], metric: 'share', isPercent: true },
  pipeline: () => [
    ...activePlayersStages(),
    {
      $lookup: {
        from: 'screenshots',
        localField: '_id',
        foreignField: 'creatorId',
        as: 'screenshots',
        pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }]
      }
    },
    {
      $group: {
        _id: null,
        players: { $sum: 1 },
        uploaders: { $sum: { $size: '$screenshots' } }
      }
    },
    { $project: { _id: 0, share: ratioExpression('$uploaders', '$players') } }
  ]
};
