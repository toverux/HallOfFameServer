/**
 * The Depth cards on the main menu's audience: how long a session stays in the main menu before a
 * city loads, and how many sessions never load one, from the `context_entered` events.
 * The mod sends that event when a load completes, so the time includes the city's loading screen.
 */

import type { Prisma } from '#prisma-lib/client';
import { ratioExpression, weekOf } from '../expressions';
import type { FeatureUsageCard } from './dashboard';

const minuteInMs = 60 * 1000;

const quartiles = [
  { label: '25th percentile', percentile: 0.25, color: '#A6E7F3' },
  { label: 'Median', percentile: 0.5, color: '#509EE3' },
  { label: '75th percentile', percentile: 0.75, color: '#2D6BB4' }
] as const;

export const menuTimePerWeek: FeatureUsageCard = {
  name: 'Time from main menu to city loaded, per week',
  description: `Minutes from a session's first main menu to its first city or editor loaded, the time the slideshow and then the loading screen background have to show screenshots, as quartiles of the week's sessions that loaded one. A session counts in the week it started; one whose events disorder the two, as a game launched straight into a save, is left out.`,
  collection: 'usage_events',
  chart: {
    display: 'line',
    dimensions: ['week', 'quartile'],
    metric: 'minutes',
    seriesColors: Object.fromEntries(quartiles.map(quartile => [quartile.label, quartile.color]))
  },
  pipeline: () => [
    ...contextStages(),
    {
      $project: {
        week: 1,
        minutes: { $divide: [{ $subtract: ['$cityAt', '$menuAt'] }, minuteInMs] }
      }
    },
    { $match: { minutes: { $gt: 0 } } },
    {
      $group: {
        _id: '$week',
        minutes: {
          $percentile: {
            input: '$minutes',
            // oxlint-disable-next-line id-length - the operator's own field
            p: quartiles.map(quartile => quartile.percentile),
            method: 'approximate'
          }
        }
      }
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        rows: quartiles.map((quartile, index) => ({
          quartile: quartile.label,
          minutes: { $round: [{ $arrayElemAt: ['$minutes', index] }, 1] }
        })),
        week: '$_id'
      }
    },
    { $unwind: '$rows' },
    { $project: { week: 1, quartile: '$rows.quartile', minutes: '$rows.minutes' } }
  ]
};

export const menuOnlySessionsPerWeek: FeatureUsageCard = {
  name: 'Sessions that never load a city, per week',
  description: `Share of the week's sessions that reached the main menu and never loaded a city or the editor: the player only browsed the menu, or quit while the city loaded.`,
  collection: 'usage_events',
  chart: { display: 'line', dimensions: ['week'], metric: 'sessionShare', isPercent: true },
  pipeline: () => [
    ...contextStages(),
    {
      $group: {
        _id: '$week',
        sessions: { $sum: { $cond: [{ $ne: ['$menuAt', null] }, 1, 0] } },
        menuOnly: {
          $sum: {
            $cond: [{ $and: [{ $ne: ['$menuAt', null] }, { $eq: ['$cityAt', null] }] }, 1, 0]
          }
        }
      }
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, week: '$_id', sessionShare: ratioExpression('$menuOnly', '$sessions') } }
  ]
};

/**
 * Stages yielding a row per session of an ended week: its `week`, by its first event's receipt, and
 * when it first entered the main menu (`menuAt`) and a city or the editor (`cityAt`), null where it
 * never did, by the client's clock.
 */
function contextStages(): Prisma.InputJsonObject[] {
  const firstAt = (modes: readonly string[]): Prisma.InputJsonObject => ({
    $min: { $cond: [{ $in: ['$properties.mode', modes] }, '$trackedAt', null] }
  });

  return [
    { $match: { isDebug: false, name: 'context_entered' } },
    {
      $group: {
        _id: '$sessionId',
        firstReceivedAt: { $min: '$receivedAt' },
        menuAt: firstAt(['MainMenu']),
        cityAt: firstAt(['Game', 'Editor'])
      }
    },
    { $addFields: { week: weekOf('$firstReceivedAt') } },
    { $match: { $expr: { $lt: ['$week', weekOf('$$NOW')] } } }
  ];
}
