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

/**
 * The first mod release whose events tell how each flow went: every started upload's outcome, the
 * details window's opening tab, and the tour's start at its first balloon shown.
 * Change it with the release's number if that release ships under another one.
 */
export const firstReleaseWithCompleteEvents = '2026.8.0';

/**
 * An event counted per value of its properties as well as whole: each listed value under
 * `<event>__<value>`, the event as a whole under its plain name.
 * A value outside the list gets no count of its own, so a card derives it from the whole.
 */
export interface PropertySplit {
  readonly event: string;

  /**
   * Expression over the event's document yielding the value it counts under.
   */
  readonly key: Prisma.InputJsonValue;

  readonly values: readonly string[];
}

/**
 * How {@link sessionStages} reads the sessions.
 */
export interface SessionOptions {
  /**
   * Keeps only the sessions of this mod release or later, every event of a session carrying the
   * same version.
   */
  readonly sinceRelease?: string;

  /**
   * Counts each name an event pushes once per session, for a card asking only whether a session did
   * something: an event's count is then 1 or 0, and a split's whole count the number of distinct
   * values the session sent, those outside the list as one.
   * The group then holds each name once per session rather than every event.
   */
  readonly isPresenceOnly?: boolean;
}

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
 * A {@link PropertySplit} adds the counts of its event, whole and per listed value.
 * A session counts only if it holds a usage event, and not from a debug build: server rows carry no
 * debug flag, so this keeps the author's test sessions out of them too.
 * A session belongs to the week of its first event's receipt, all its rows with it, and shows once
 * that week has ended.
 */
export function sessionStages(
  counted: ReadonlyArray<string | PropertySplit>,
  options: SessionOptions = {}
): Prisma.InputJsonObject[] {
  const { sinceRelease, isPresenceOnly = false } = options;

  const names = counted.filter(item => typeof item == 'string');

  const splits = counted.filter(item => typeof item != 'string');

  const serverNames = names.filter((name): name is ServerRowName => name in serverRowSources);

  const eventNames = names.filter(name => !(name in serverRowSources));

  const eventCounts = [
    ...eventNames.map(name => [name, countOf([name])] as const),
    ...splits.flatMap(split => {
      const valueNames = split.values.map(value => splitName(split.event, value));

      return [
        [split.event, countOf([split.event, ...valueNames])] as const,
        ...valueNames.map(name => [name, countOf([name])] as const)
      ];
    })
  ];

  // A split event pushes its value's name, or its plain name for a value outside the list.
  const pushedName = splits.reduceRight<Prisma.InputJsonValue>(
    (otherwise, split) => ({
      $cond: [{ $eq: ['$name', split.event] }, splitNameExpression(split), otherwise]
    }),
    { $cond: [{ $in: ['$name', eventNames] }, '$name', '$$REMOVE'] }
  );

  // Each source groups its rows by session before the union, so the last group reads one row per
  // session and source, and only the server rows asked for are read.
  // The groups keep little state per session, as a group past its memory limit spills to disk: the
  // events push only the names counted, and the last group merges each session's rows into one.
  // The release gate filters after the session group, on the version the group carries: `$split`
  // in a `$match` before it would keep the group out of the slot-based engine, whose group holds a
  // session in less memory than the classic one.
  return [
    { $match: { isDebug: false } },
    {
      $group: {
        _id: '$sessionId',
        creatorId: { $first: '$creatorId' },
        ...(sinceRelease != null && { modVersion: { $first: '$modVersion' } }),
        firstReceivedAt: { $min: '$receivedAt' },
        names: { [isPresenceOnly ? '$addToSet' : '$push']: pushedName }
      }
    },
    ...(sinceRelease == null
      ? []
      : [
          { $match: { $expr: { $gte: [versionParts('$modVersion'), releaseParts(sinceRelease)] } } }
        ]),
    { $project: { creatorId: 1, firstReceivedAt: 1, ...Object.fromEntries(eventCounts) } },
    // Without server rows, each session already has its one row, and the merge would cost a group.
    ...(serverNames.length ? serverRowsMergeStages(serverNames) : []),
    { $addFields: { week: weekOf('$firstReceivedAt') } },
    { $match: { $expr: { $lt: ['$week', weekOf('$$NOW')] } } }
  ];
}

/**
 * The expression of a session's count of a split's event with the given listed value.
 */
export function splitCount(split: PropertySplit, value: string): string {
  return `$${splitName(split.event, value)}`;
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
            { $gte: [versionParts('$modVersion'), releaseParts(firstReleaseWithEvents)] }
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
 * Stages adding the server rows of the given names to the session rows of the events, and dropping
 * the sessions that hold no event.
 */
function serverRowsMergeStages(serverNames: readonly ServerRowName[]): Prisma.InputJsonObject[] {
  return [
    ...serverNames.map(name => serverRowsUnion(name)),
    // One accumulator merging the whole rows holds a session in less memory than one per field, and
    // the sources' fields never overlap but for the session ID.
    { $group: { _id: '$_id', session: { $mergeObjects: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$session' } },
    // Only events carry it, so a session without one has none.
    { $match: { firstReceivedAt: { $exists: true } } }
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
 * The name a property split counts one of its listed values under.
 */
function splitName(event: string, value: string): string {
  return `${event}__${value}`;
}

/**
 * The expression of the count of a session's pushed names that are among the given ones.
 */
function countOf(names: readonly string[]): Prisma.InputJsonObject {
  return { $size: { $filter: { input: '$names', cond: { $in: ['$$this', names] } } } };
}

/**
 * The expression of the name an event of a split counts under.
 */
function splitNameExpression(split: PropertySplit): Prisma.InputJsonObject {
  return {
    $let: {
      vars: { value: split.key },
      in: {
        $cond: [
          { $in: ['$$value', split.values] },
          { $concat: [splitName(split.event, ''), '$$value'] },
          split.event
        ]
      }
    }
  };
}

/**
 * A release's parts as {@link versionParts} compares them.
 */
function releaseParts(release: string): number[] {
  return release.split('.').map(Number);
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
