import { dayOf } from '../expressions';
import type { NewcomersCard } from './dashboard';

export const dailyActives: NewcomersCard = {
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
