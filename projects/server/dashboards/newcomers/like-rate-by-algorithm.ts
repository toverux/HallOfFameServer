import { weekOf } from './cohort-stages';
import type { DashboardCard } from './dashboard';

/**
 * Per week and per algorithm, the share of the views it served that the viewer liked, at the view
 * or later: the baseline later changes to the weighted algorithms are judged on.
 * Counts only the views labelled with the algorithm that served them.
 */
export const likeRateByAlgorithm: DashboardCard = {
  name: 'Like rate by algorithm',
  collection: 'views',
  pipeline: period => [
    // Excludes both a missing and a null algorithm.
    { $match: { algorithm: { $type: 'string' } } },
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
        views: 1,
        likeRate: { $divide: ['$likes', '$views'] }
      }
    },
    { $sort: { week: 1, period: 1, algorithm: 1 } }
  ]
};
