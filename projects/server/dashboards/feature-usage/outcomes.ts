import type { Prisma } from '#prisma-lib/client';
import type { FeatureUsageCard } from './dashboard';
import {
  firstReleaseWithCompleteEvents,
  type PropertySplit,
  sessionStages,
  splitCount
} from './sessions';

/**
 * A series of an outcome card.
 */
interface Outcome {
  readonly label: string;

  readonly color: string;

  /**
   * Expression of the series' count in a session, over the session's counts.
   */
  readonly count: Prisma.InputJsonValue;
}

/**
 * The outcomes of `upload_finished` with a series of their own, in the legend's order after Stored.
 */
const listedUploadFailures = [
  { label: 'Encoding failed', value: 'encode_failed', color: '#F9D45C' },
  { label: 'Network error', value: 'network', color: '#F2A86F' },
  { label: 'Unreadable response', value: 'bad_response', color: '#E8875B' },
  { label: 'Refused', value: 'rejected', color: '#EF8C8C' },
  { label: 'Mod outdated', value: 'incompatible', color: '#E35850' },
  { label: 'Server error', value: 'server_error', color: '#B8423C' }
] as const;

const uploadFinished: PropertySplit = {
  event: 'upload_finished',
  key: '$properties.outcome',
  values: ['stored', ...listedUploadFailures.map(failure => failure.value)]
};

const uploadOutcomes: readonly Outcome[] = [
  // The capture funnel's color for Screenshots stored.
  { label: 'Stored', color: '#2D6BB4', count: splitCount(uploadFinished, 'stored') },
  ...listedUploadFailures.map(failure => ({
    label: failure.label,
    color: failure.color,
    count: splitCount(uploadFinished, failure.value)
  })),
  { label: 'Other error', color: '#8C3A3A', count: unlistedCount(uploadFinished) },
  {
    label: 'No outcome reported',
    color: '#B8BBC3',
    count: missingEnds('upload_started', uploadFinished)
  }
];

/**
 * A `tour_finished` keyed by how the tour ended: completed first, as closing the last balloon also
 * reports the step, then left menu, as leaving the menu also reports the step, then the step.
 */
const tourFinished: PropertySplit = {
  event: 'tour_finished',
  key: {
    $cond: [
      { $eq: ['$properties.completed', true] },
      'completed',
      { $cond: [{ $eq: ['$properties.leftMenu', true] }, 'leftMenu', '$properties.step'] }
    ]
  },
  values: ['completed', 'navigation', 'menuVisibility', 'like', 'leftMenu']
};

const tourOutcomes: readonly Outcome[] = [
  { label: 'Completed', color: '#88BF4D', count: splitCount(tourFinished, 'completed') },
  // A warm ramp in the tour's step order.
  {
    label: 'Dismissed at Navigation',
    color: '#F9D45C',
    count: splitCount(tourFinished, 'navigation')
  },
  {
    label: 'Dismissed at Menu visibility',
    color: '#F2A86F',
    count: splitCount(tourFinished, 'menuVisibility')
  },
  { label: 'Dismissed at Like', color: '#E35850', count: splitCount(tourFinished, 'like') },
  { label: 'Left the main menu', color: '#949AAB', count: splitCount(tourFinished, 'leftMenu') },
  {
    label: 'No outcome reported',
    color: '#DCDFE5',
    count: missingEnds('tour_started', tourFinished)
  }
];

export const uploadOutcomesPerWeek: FeatureUsageCard = {
  name: 'Upload outcomes per week',
  description: `Every upload started in the week's sessions, by how it ended. It counts the sessions of mod ${firstReleaseWithCompleteEvents} or later whose events reached the server, eligible or not, each whole in the week it started. No outcome reported includes the outcomes lost with their usage batch, as the mod keeps its queue in memory and never sends a failed batch again; a game closed mid-upload can lose the upload's start too. Network error may be under-counted, as the usage batch can fail with the upload, and may include uploads the server stored but whose answer was lost. Stored is the server's answer reaching the mod, so it can differ slightly from the capture funnel's Screenshots stored.`,
  collection: 'usage_events',
  chart: outcomeChart(uploadOutcomes),
  pipeline: () => outcomeStages(['upload_started', uploadFinished], uploadOutcomes)
};

export const menuTourOutcomesPerWeek: FeatureUsageCard = {
  name: 'Menu tour outcomes per week',
  description: `Every main menu tour started in the week's sessions, by how it ended. Closing the last balloon counts as Completed. Dismissed at Like happens only to players with a screenshot: for the others, Like is the last step. No outcome reported includes the ends lost with their usage batch, besides games closed mid-tour. It counts the sessions of mod ${firstReleaseWithCompleteEvents} or later whose events reached the server, eligible or not, each whole in the week it started.`,
  collection: 'usage_events',
  chart: outcomeChart(tourOutcomes),
  pipeline: () => outcomeStages(['tour_started', tourFinished], tourOutcomes)
};

function outcomeChart(outcomes: readonly Outcome[]): FeatureUsageCard['chart'] {
  return {
    display: 'bar',
    dimensions: ['week', 'outcome'],
    metric: 'count',
    stacking: 'stacked',
    seriesColors: Object.fromEntries(outcomes.map(outcome => [outcome.label, outcome.color]))
  };
}

/**
 * Rows of `week`, `outcome`, and `count`, every outcome each week, in the given order.
 */
function outcomeStages(
  counted: ReadonlyArray<string | PropertySplit>,
  outcomes: readonly Outcome[]
): Prisma.InputJsonObject[] {
  return [
    ...sessionStages(counted, { sinceRelease: firstReleaseWithCompleteEvents }),
    {
      $project: {
        week: 1,
        ...Object.fromEntries(outcomes.map((outcome, index) => [`outcome${index}`, outcome.count]))
      }
    },
    {
      $group: {
        _id: '$week',
        ...Object.fromEntries(
          outcomes.map((_, index) => [`outcome${index}`, { $sum: `$outcome${index}` }])
        )
      }
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        week: '$_id',
        rows: outcomes.map((outcome, index) => ({
          outcome: outcome.label,
          count: `$outcome${index}`
        }))
      }
    },
    { $unwind: '$rows' },
    { $project: { week: 1, outcome: '$rows.outcome', count: '$rows.count' } }
  ];
}

/**
 * The expression of a session's count of a split's event with a value outside its list.
 */
function unlistedCount(split: PropertySplit): Prisma.InputJsonObject {
  return {
    $subtract: [`$${split.event}`, { $add: split.values.map(value => splitCount(split, value)) }]
  };
}

/**
 * The expression of a session's count of the starts of a flow left without the event of its end,
 * never below 0, as an end whose start was lost would offset another flow.
 */
function missingEnds(started: string, finished: PropertySplit): Prisma.InputJsonObject {
  return { $max: [0, { $subtract: [`$${started}`, `$${finished.event}`] }] };
}
