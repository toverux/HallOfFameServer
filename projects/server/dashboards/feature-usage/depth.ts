import type { Prisma } from '#prisma-lib/client';
import { ratioExpression } from '../expressions';
import type { Column, FeatureUsageCard } from './dashboard';
import { eligiblePlayersPerWeekStages, serverRowNames, sessionStages } from './sessions';

export const activePlayers = depthCard({
  name: 'Active players',
  description: `Players eligible to send usage statistics who loaded the game last week, against the week before. Eligible players run a mod version that sends them and have not switched them off.`,
  display: 'smartscalar',
  metric: 'players'
});

export const sessionsPerPlayer = depthCard({
  name: 'Sessions per player',
  description: `Game launches per active player last week, against the week before.`,
  display: 'smartscalar',
  metric: 'sessionsPerPlayer'
});

export const activePlayersPerWeek = depthCard({
  name: 'Active players per week',
  description: `Players eligible to send usage statistics who loaded the game each week: the denominator of the adoption shares and of sessions per player. A past week's count drops when a player switches usage statistics off.`,
  display: 'bar',
  metric: 'players'
});

export const sessionsPerPlayerPerWeek = depthCard({
  name: 'Sessions per player per week',
  description: `Game launches per active player each week. A session counts in the week it started.`,
  display: 'line',
  metric: 'sessionsPerPlayer'
});

export const viewsPerSessionPerWeek = depthCard({
  name: 'Views per session per week',
  description: `Screenshots seen per game launch each week, from the views carrying the launch's session ID.`,
  display: 'line',
  metric: 'viewsPerSession'
});

/**
 * A card drawing one column of the weekly depth rows.
 */
function depthCard(
  options: Readonly<{
    name: string;
    description: string;
    display: 'smartscalar' | 'bar' | 'line';
    metric: Column;
  }>
): FeatureUsageCard {
  return {
    name: options.name,
    description: options.description,
    collection: 'usage_events',
    chart: { display: options.display, dimensions: ['week'], metric: options.metric },
    pipeline: () => depthStages()
  };
}

/**
 * Rows of `week`, the eligible `players`, their `sessions` and `views`, and the two ratios.
 */
function depthStages(): Prisma.InputJsonObject[] {
  return [
    ...sessionStages([serverRowNames.viewed]),
    {
      $project: {
        creatorId: 1,
        week: 1,
        sessions: { $literal: 1 },
        views: `$${serverRowNames.viewed}`
      }
    },
    ...eligiblePlayersPerWeekStages({ sessions: { $sum: '$sessions' }, views: { $sum: '$views' } }),
    {
      $project: {
        _id: 0,
        week: '$_id',
        players: 1,
        sessions: 1,
        views: 1,
        sessionsPerPlayer: ratioExpression('$sessions', '$players'),
        viewsPerSession: ratioExpression('$views', '$sessions')
      }
    },
    { $sort: { week: 1 } }
  ];
}
