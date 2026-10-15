import type { DashboardCard } from './dashboard';

/**
 * The creators who loaded the game with the mod each UTC day, slideshow or not.
 * Counted from the activity records, so the series starts when they were first recorded.
 */
export const dailyActives: DashboardCard = {
  name: 'Daily actives',
  collection: 'creator_activities',
  pipeline: period => [
    { $group: { _id: { day: '$day', period: period('$day') }, creators: { $sum: 1 } } },
    { $project: { _id: 0, day: '$_id.day', period: '$_id.period', creators: 1 } },
    { $sort: { day: 1 } }
  ]
};
