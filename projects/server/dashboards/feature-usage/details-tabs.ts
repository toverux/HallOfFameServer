import type { Prisma } from '#prisma-lib/client';
import { ratioExpression } from '../expressions';
import type { FeatureUsageCard } from './dashboard';
import {
  firstReleaseWithCompleteEvents,
  type PropertySplit,
  sessionStages,
  splitCount
} from './sessions';

/**
 * The tabs of the screenshot details window, in display order.
 */
const tabs = [
  { label: 'Description', value: 'description', color: '#509EE3' },
  { label: 'Photo mode settings', value: 'photoModeSettings', color: '#88BF4D' },
  { label: 'Playset', value: 'playset', color: '#A989C5' }
] as const;

/**
 * The window opening on a tab, counted whole too, so an opening on an unlisted tab still makes the
 * player an opener.
 */
const opened: PropertySplit = {
  event: 'screenshot_details_opened',
  key: '$properties.tab',
  values: tabs.map(tab => tab.value)
};

const switched: PropertySplit = {
  event: 'screenshot_details_tab_changed',
  key: '$properties.tab',
  values: tabs.map(tab => tab.value)
};

export const detailsTabsPerWeek: FeatureUsageCard = {
  name: 'Details window tabs per week',
  description: `Share of the week's players who opened the screenshot details window that viewed each tab, opening the window on it or switching to it. It counts the players whose events reached the server, from mod ${firstReleaseWithCompleteEvents} on, rather than the eligible players, so it does not compare with the adoption shares.`,
  collection: 'usage_events',
  chart: {
    display: 'line',
    dimensions: ['week', 'tab'],
    metric: 'share',
    isPercent: true,
    seriesColors: Object.fromEntries(tabs.map(tab => [tab.label, tab.color]))
  },
  pipeline: () => detailsTabsStages()
};

/**
 * Rows of `week`, `tab`, and `share`, every tab each week, in display order; a share is null where
 * no player opened the window that week.
 */
function detailsTabsStages(): Prisma.InputJsonObject[] {
  const tabKeys = tabs.map((_, index) => `tab${index}`);

  return [
    ...sessionStages([opened, switched], { sinceRelease: firstReleaseWithCompleteEvents }),
    // Whether the session opened the window and viewed each tab, as 1 or 0.
    // The sessions that opened none share one player per week, null, which counts as no opener
    // and keeps the week's row while holding little state in the next group.
    // A tab counts only in a session that opened the window, so a share stays within its openers.
    {
      $project: {
        week: 1,
        player: { $cond: [{ $gt: [`$${opened.event}`, 0] }, '$creatorId', null] },
        opener: isPositive(`$${opened.event}`),
        ...Object.fromEntries(
          tabs.map((tab, index) => [
            `tab${index}`,
            isPositive({
              $min: [
                `$${opened.event}`,
                { $add: [splitCount(opened, tab.value), splitCount(switched, tab.value)] }
              ]
            })
          ])
        )
      }
    },
    // A player counts once a week however many of their sessions viewed a tab.
    {
      $group: {
        _id: { player: '$player', week: '$week' },
        opener: { $max: '$opener' },
        ...Object.fromEntries(tabKeys.map(key => [key, { $max: `$${key}` }]))
      }
    },
    {
      $group: {
        _id: '$_id.week',
        openers: { $sum: '$opener' },
        ...Object.fromEntries(tabKeys.map(key => [key, { $sum: `$${key}` }]))
      }
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        week: '$_id',
        rows: tabs.map((tab, index) => ({
          tab: tab.label,
          share: ratioExpression(`$tab${index}`, '$openers')
        }))
      }
    },
    { $unwind: '$rows' },
    { $project: { week: 1, tab: '$rows.tab', share: '$rows.share' } }
  ];
}

/**
 * The expression of whether a count is above 0, as 1 or 0.
 */
function isPositive(count: Prisma.InputJsonValue): Prisma.InputJsonObject {
  return { $cond: [{ $gt: [count, 0] }, 1, 0] };
}
