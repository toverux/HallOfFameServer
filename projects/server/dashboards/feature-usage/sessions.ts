/**
 * Stages the Feature usage cards share, which run on `usage_events`.
 * A session is a game launch, the rows carrying its session ID: the usage events the mod sent, and
 * the screenshots, views, and likes the server stored from the launch's requests.
 */

import type { Prisma } from '#prisma-lib/client';
import { weekOf } from '../expressions';

/**
 * Names the server rows take beside the usage events' names, which never include them: the mod
 * sends no event for a moment the server records as a row.
 */
export const serverRowNames = {
  stored: 'screenshot_stored',
  viewed: 'screenshot_viewed',
  liked: 'screenshot_liked'
} as const;

/**
 * The first mod release that sends usage events.
 */
export const firstReleaseWithEvents = '2026.6.0';

type ServerRowName = (typeof serverRowNames)[keyof typeof serverRowNames];

/**
 * Where the server rows of each name come from.
 */
const serverRowSources: Readonly<
  Record<ServerRowName, Readonly<{ collection: string; sessionField: string }>>
> = {
  [serverRowNames.stored]: { collection: 'screenshots', sessionField: 'uploadSessionId' },
  [serverRowNames.viewed]: { collection: 'views', sessionField: 'sessionId' },
  [serverRowNames.liked]: { collection: 'favorites', sessionField: 'sessionId' }
};

/**
 * Groups the rows of each session into a document of `creatorId`, `week`, and the count of the
 * session's rows of each given name, an event's or a server row's, under the name; a server row's
 * count is absent where the session has none.
 * A session counts only if it holds a usage event, and not from a debug build: server rows carry no
 * debug flag, so this keeps the author's test sessions out of them too.
 * A session belongs to the week of its first event's receipt, all its rows with it, and shows once
 * that week has ended.
 */
export function sessionStages(names: readonly string[]): Prisma.InputJsonObject[] {
  const serverNames = names.filter((name): name is ServerRowName => name in serverRowSources);

  const eventNames = names.filter(name => !(name in serverRowSources));

  // Each source groups its rows by session before the union, so the last group reads one row per
  // session and source, and only the server rows asked for are read.
  // The groups keep little state per session, as a group past its memory limit spills to disk: the
  // events push only the names counted, and the last group merges with `$max`, each source holding
  // its own counts.
  return [
    { $match: { isDebug: false } },
    {
      $group: {
        _id: '$sessionId',
        creatorId: { $first: '$creatorId' },
        firstReceivedAt: { $min: '$receivedAt' },
        names: { $push: { $cond: [{ $in: ['$name', eventNames] }, '$name', '$$REMOVE'] } }
      }
    },
    {
      $project: {
        creatorId: 1,
        firstReceivedAt: 1,
        ...Object.fromEntries(
          eventNames.map(name => [
            name,
            { $size: { $filter: { input: '$names', cond: { $eq: ['$$this', name] } } } }
          ])
        )
      }
    },
    ...serverNames.map(name => serverRowsUnion(name)),
    {
      $group: {
        _id: '$_id',
        // Only events carry these two, and every session left holds one.
        creatorId: { $max: '$creatorId' },
        firstReceivedAt: { $min: '$firstReceivedAt' },
        ...Object.fromEntries(names.map(name => [name, { $max: `$${name}` }]))
      }
    },
    { $match: { firstReceivedAt: { $ne: null } } },
    { $addFields: { week: weekOf('$firstReceivedAt') } },
    { $match: { $expr: { $lt: ['$week', weekOf('$$NOW')] } } }
  ];
}

/**
 * Keeps the rows of the last ended week, those of a card showing last week alone.
 */
export const lastWeekStage: Prisma.InputJsonObject = {
  $match: {
    $expr: {
      $eq: ['$week', { $dateSubtract: { startDate: weekOf('$$NOW'), unit: 'week', amount: 1 } }]
    }
  }
};

/**
 * Turns rows of `creatorId` and `week` into one row per ended week: `_id` the week, `players` the
 * count of the players eligible to send usage events that week, and the given accumulators, per
 * player and week, then summed per week, over the rows of those players alone. An eligible player
 * loaded the game that week with a mod release that sends usage events, and their metadata does not
 * report the "Send usage statistics" toggle as off. The toggle is read as of now, so a past week's
 * figures move when a player opts out.
 */
export function eligiblePlayersPerWeekStages(
  perPlayer: Prisma.InputJsonObject
): Prisma.InputJsonObject[] {
  const perWeek = Object.fromEntries(Object.keys(perPlayer).map(key => [key, { $sum: `$${key}` }]));

  return [
    {
      $unionWith: {
        coll: 'creator_activities',
        pipeline: [
          ...eligiblePlayerWeekStages(),
          { $addFields: { isEligible: { $literal: true } } }
        ]
      }
    },
    {
      $group: {
        _id: { creatorId: '$creatorId', week: '$week' },
        isEligible: { $max: '$isEligible' },
        ...perPlayer
      }
    },
    { $match: { isEligible: true } },
    { $group: { _id: '$_id.week', players: { $sum: 1 }, ...perWeek } }
  ];
}

/**
 * Stages on `creator_activities` listing the eligible player-weeks as `creatorId` and `week`.
 */
function eligiblePlayerWeekStages(): Prisma.InputJsonObject[] {
  return [
    {
      $match: {
        $expr: {
          $and: [
            { $lt: ['$day', weekOf('$$NOW')] },
            { $gte: [versionParts('$modVersion'), firstReleaseWithEvents.split('.').map(Number)] }
          ]
        }
      }
    },
    { $group: { _id: { creatorId: '$creatorId', week: weekOf('$day') } } },
    { $project: { _id: 0, creatorId: '$_id.creatorId', week: '$_id.week' } },
    // The mod reports its settings in the creator's metadata, the toggle under this key.
    {
      $unionWith: {
        coll: 'creators',
        pipeline: [
          { $match: { 'metadata.sendUsageStatistics': false } },
          { $project: { _id: 0, creatorId: '$_id', isOptedOut: { $literal: true } } }
        ]
      }
    },
    {
      $group: {
        _id: '$creatorId',
        isOptedOut: { $max: '$isOptedOut' },
        weeks: { $push: '$week' }
      }
    },
    { $match: { isOptedOut: { $ne: true } } },
    { $unwind: '$weeks' },
    { $project: { _id: 0, creatorId: '$_id', week: '$weeks' } }
  ];
}

/**
 * The count of the server rows of a name per session ID, under the name.
 */
function serverRowsUnion(name: ServerRowName): Prisma.InputJsonObject {
  const { collection, sessionField } = serverRowSources[name];

  return {
    $unionWith: {
      coll: collection,
      pipeline: [
        { $match: { [sessionField]: { $type: 'string' } } },
        { $group: { _id: `$${sessionField}`, [name]: { $sum: 1 } } }
      ]
    }
  };
}

/**
 * The expression of a version's dot-separated parts as integers, which compare in order as arrays
 * where strings would sort "1.10.0" below "1.9.0".
 * A missing version or part that is not a number compares as 0.
 */
function versionParts(version: string): Prisma.InputJsonObject {
  return {
    $map: {
      input: { $split: [{ $ifNull: [version, '0'] }, '.'] },
      as: 'part',
      in: { $convert: { input: '$$part', to: 'int', onError: 0 } }
    }
  };
}
