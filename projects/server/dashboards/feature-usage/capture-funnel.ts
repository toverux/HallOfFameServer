import type { Prisma } from '#prisma-lib/client';
import { ratioExpression } from '../expressions';
import type { FeatureUsageCard } from './dashboard';
import { lastWeekStage, serverRowNames, sessionStages } from './sessions';

/**
 * The steps of the capture flow, in order, each counting its rows of a session.
 * The upload panel shows only once a capture succeeded, so a request is the one step before it.
 */
const steps = [
  { label: 'Captures requested', name: 'capture_requested', color: '#A6E7F3' },
  { label: 'Screenshots captured', name: 'screenshot_captured', color: '#69C8EB' },
  { label: 'Uploads started', name: 'upload_started', color: '#509EE3' },
  { label: 'Screenshots stored', name: serverRowNames.stored, color: '#2D6BB4' }
] as const;

export const captureFunnelPerWeek: FeatureUsageCard = {
  name: 'Capture funnel per week',
  description: `Captures requested in photo mode, screenshots captured, uploads started, and screenshots the server stored, summed over the week's sessions. A session counts whole in the week it started. An upload abandoned or failed shows as a stored screenshot missing; Upload outcomes per week tells why.`,
  collection: 'usage_events',
  chart: {
    display: 'bar',
    dimensions: ['week', 'step'],
    metric: 'count',
    seriesColors: Object.fromEntries(steps.map(step => [step.label, step.color]))
  },
  pipeline: () => [...funnelStages(), ...stepRowStages()]
};

export const captureFunnelLastWeek: FeatureUsageCard = {
  name: 'Capture funnel, last week',
  description: `The capture funnel of last week's sessions, from captures requested in photo mode to screenshots the server stored.`,
  collection: 'usage_events',
  chart: { display: 'funnel', dimensions: ['step'], metric: 'count' },
  pipeline: () => [...funnelStages(), lastWeekStage, ...stepRowStages()]
};

export const uploadRate: FeatureUsageCard = {
  name: 'Upload rate',
  description: `Screenshots stored divided by screenshots captured, over last week's sessions, against the week before.`,
  collection: 'usage_events',
  chart: { display: 'smartscalar', dimensions: ['week'], metric: 'uploadRate', isPercent: true },
  pipeline: () => [
    ...funnelStages(),
    {
      $project: {
        week: 1,
        uploadRate: ratioExpression(`$${serverRowNames.stored}`, '$screenshot_captured')
      }
    }
  ]
};

/**
 * Rows of `week` and each step's count under its name.
 */
function funnelStages(): Prisma.InputJsonObject[] {
  return [
    ...sessionStages(steps.map(step => step.name)),
    {
      $group: {
        _id: '$week',
        ...Object.fromEntries(steps.map(step => [step.name, { $sum: `$${step.name}` }]))
      }
    },
    {
      $project: {
        _id: 0,
        week: '$_id',
        ...Object.fromEntries(steps.map(step => [step.name, 1]))
      }
    },
    { $sort: { week: 1 } }
  ];
}

/**
 * Turns each week's row into a row of `week`, `step`, and `count` per step, in the steps' order.
 */
function stepRowStages(): Prisma.InputJsonObject[] {
  return [
    {
      $project: {
        week: 1,
        steps: steps.map(step => ({ step: step.label, count: `$${step.name}` }))
      }
    },
    { $unwind: '$steps' },
    { $project: { week: 1, step: '$steps.step', count: '$steps.count' } }
  ];
}
