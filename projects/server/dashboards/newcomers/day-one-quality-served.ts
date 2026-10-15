import { nn } from '../../../shared/utils/type-assertion';
import { percentileFacet, ScreenshotStatsService } from '../../services/screenshot-stats.service';
import {
  cohortMemberStages,
  dayOneLookupStage,
  groupByCohortStages,
  ratioExpression
} from './cohort-stages';
import type { DashboardCard } from './dashboard';

const { rankPercentiles, rankableFilter, likeRateExpression } = ScreenshotStatsService;

const goldPercentile = nn(rankPercentiles.find(({ rank }) => rank == 'gold')).percentile;

export const dayOneQualityServed: DashboardCard = {
  name: 'Day-1 quality served',
  description: `Share of first-day views on screenshots that rank Gold or better today. Past cohorts are measured against today's medals, so older values are approximate.`,
  collection: 'creators',
  chart: {
    display: 'line',
    dimensions: ['week', 'period'],
    metric: 'qualityServed',
    isPercent: true
  },
  pipeline: period => [
    ...cohortMemberStages(period),
    // Uncorrelated, so MongoDB runs it once and reuses its result for every member.
    {
      $lookup: {
        from: 'screenshots',
        pipeline: percentileFacet(rankableFilter, likeRateExpression, [goldPercentile]),
        as: 'goldCutPoint'
      }
    },
    { $set: { goldCutPoint: { $first: { $first: '$goldCutPoint.percentiles' } } } },
    dayOneLookupStage('views', 'views', [{ $project: { _id: 0, screenshotId: 1 } }]),
    // `localField` is the array of day-1 screenshot IDs, so one lookup serves the member's views.
    {
      $lookup: {
        from: 'screenshots',
        localField: 'views.screenshotId',
        foreignField: '_id',
        let: { goldCutPoint: '$goldCutPoint' },
        // The rate is computed past the floors' $match, never on zero unique views.
        pipeline: [
          { $match: rankableFilter },
          { $project: { isGold: { $gte: [likeRateExpression, '$$goldCutPoint'] } } },
          { $match: { isGold: true } }
        ],
        as: 'goldScreenshots'
      }
    },
    ...groupByCohortStages(
      {
        views: { $sum: { $size: '$views' } },
        goldViews: {
          $sum: {
            $size: {
              $filter: {
                input: '$views',
                cond: { $in: ['$$this.screenshotId', '$goldScreenshots._id'] }
              }
            }
          }
        }
      },
      { qualityServed: ratioExpression('$goldViews', '$views') }
    )
  ]
};
