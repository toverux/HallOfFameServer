import { dayOf } from './cohort-stages';
import type { DashboardCard } from './dashboard';

export const dailyActivesByModVersion: DashboardCard = {
  name: 'Daily actives by mod version',
  description: `Daily actives split by the mod version each player reported that day, with "unknown" when none was sent. Shows how fast each release reaches players.`,
  collection: 'creator_activities',
  chart: {
    display: 'bar',
    dimensions: ['day', 'modVersion'],
    metric: 'creators',
    isStacked: true
  },
  pipeline: period => [
    // Today's count is still growing.
    { $match: { $expr: { $lt: ['$day', dayOf('$$NOW')] } } },
    {
      $group: {
        _id: {
          day: '$day',
          period: period('$day'),
          modVersion: { $ifNull: ['$modVersion', 'unknown'] }
        },
        creators: { $sum: 1 }
      }
    },
    {
      $project: {
        _id: 0,
        day: '$_id.day',
        period: '$_id.period',
        modVersion: '$_id.modVersion',
        creators: 1
      }
    },
    { $sort: { day: 1, modVersion: 1 } }
  ]
};
