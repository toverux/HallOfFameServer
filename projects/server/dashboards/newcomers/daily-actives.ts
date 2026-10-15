import { dayOf } from './cohort-stages';
import type { DashboardCard } from './dashboard';

export const dailyActives: DashboardCard = {
  name: 'Daily actives',
  description: `Players who loaded the game with the mod each UTC day, whether the slideshow is on or off. The series starts when the server began recording game loads.`,
  collection: 'creator_activities',
  chart: { display: 'line', dimensions: ['day', 'period'], metric: 'creators' },
  pipeline: period => [
    // Today's count is still growing.
    { $match: { $expr: { $lt: ['$day', dayOf('$$NOW')] } } },
    { $group: { _id: { day: '$day', period: period('$day') }, creators: { $sum: 1 } } },
    { $project: { _id: 0, day: '$_id.day', period: '$_id.period', creators: 1 } },
    { $sort: { day: 1 } }
  ]
};
