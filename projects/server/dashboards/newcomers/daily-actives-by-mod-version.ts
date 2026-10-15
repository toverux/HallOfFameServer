import type { DashboardCard } from './dashboard';

/**
 * The daily actives split by the mod version each reported that day, "unknown" for none, so the
 * split sums to the total: shows how fast each release reaches players.
 */
export const dailyActivesByModVersion: DashboardCard = {
  name: 'Daily actives by mod version',
  collection: 'creator_activities',
  pipeline: period => [
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
