import { weekOf } from './cohort-stages';
import type { DashboardCard } from './dashboard';

export const likeRateByAlgorithm: DashboardCard = {
  name: 'Like rate by algorithm',
  description: `For each week and algorithm, the share of views that the player liked, at the time or later. Only views labelled with the algorithm that served them count.`,
  collection: 'views',
  chart: {
    display: 'line',
    dimensions: ['week', 'series'],
    metric: 'likeRate',
    isPercent: true
  },
  pipeline: period => [
    {
      $match: {
        // Excludes both a missing and a null algorithm.
        algorithm: { $type: 'string' },
        // The week in progress holds the views least likely to be liked yet.
        $expr: { $lt: ['$viewedAt', weekOf('$$NOW')] }
      }
    },
    {
      $lookup: {
        from: 'favorites',
        localField: 'screenshotId',
        foreignField: 'screenshotId',
        let: { creatorId: '$creatorId', viewedAt: '$viewedAt' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$creatorId', '$$creatorId'] },
                  { $gte: ['$favoritedAt', '$$viewedAt'] }
                ]
              }
            }
          },
          { $project: { _id: 1 } }
        ],
        as: 'likes'
      }
    },
    {
      $group: {
        _id: { week: weekOf('$viewedAt'), period: period('$viewedAt'), algorithm: '$algorithm' },
        views: { $sum: 1 },
        // A creator likes a screenshot at most once.
        likes: { $sum: { $size: '$likes' } }
      }
    },
    {
      $project: {
        _id: 0,
        week: '$_id.week',
        period: '$_id.period',
        algorithm: '$_id.algorithm',
        // A chart draws one breakout column, so each algorithm splits at shipped changes here.
        series: { $concat: ['$_id.algorithm', ', ', '$_id.period'] },
        views: 1,
        likeRate: { $divide: ['$likes', '$views'] }
      }
    },
    { $sort: { week: 1, period: 1, algorithm: 1 } }
  ]
};
