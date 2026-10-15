/**
 * The Newcomers dashboard's cards, each a MongoDB pipeline run as a Metabase native question
 * on the card's collection, which `dashboard sync` pushes to Metabase.
 * Pipelines hold only JSON values (dates through `$toDate`), so each one serializes as the
 * question's body.
 */

import type { Prisma } from '#prisma-lib/client';
import { cohortSize } from './cohort-size';
import { dailyActives } from './daily-actives';
import { dailyActivesByModVersion } from './daily-actives-by-mod-version';
import { dayOneDepth } from './day-one-depth';
import { dayOneLikeRate } from './day-one-like-rate';
import { dayOneNewcomerPicks } from './day-one-newcomer-picks';
import { dayOneQualityServed } from './day-one-quality-served';
import { likeRateByAlgorithm } from './like-rate-by-algorithm';
import { dayOneRetention, daySevenRetention, dayThirtyRetention } from './retention';
import { type ShippedChange, shippedChanges } from './shipped-changes';

export type { ShippedChange } from './shipped-changes';

/**
 * Name of the dashboard in Metabase, and of the collection holding it and its questions.
 */
export const dashboardName = 'Newcomers';

/**
 * Markdown opening the dashboard, on how to read it.
 */
export const introduction = [
  `**How to read this dashboard**`,
  `Newcomers are grouped into cohorts by the UTC week (Monday to Sunday) in which they created their account. Day 1 is a newcomer's first 24 hours. Cohorts start with the week of November 4, 2024, after the mod's launch weeks.`,
  `Each chart splits its series at every shipped change, except Daily actives by mod version, whose series are releases. Wait for about four cohorts on each side of a change before reading it, and check the cohort sizes.`
].join('\n\n');

/**
 * Titles of the columns the pipelines output, as the charts and tables show them.
 */
export const columnTitles = {
  week: 'Week',
  day: 'Day',
  period: 'Period',
  creators: 'Players',
  views: 'Views',
  likeRate: 'Like rate',
  depth: 'Median views',
  qualityServed: 'Gold or better',
  newcomerShare: 'Newcomer picks',
  d1: 'D1',
  d7: 'D7',
  d30: 'D30',
  modVersion: 'Mod version',
  algorithm: 'Algorithm',
  series: 'Algorithm, period'
} as const satisfies Record<string, string>;

/**
 * A column the pipelines output.
 */
export type Column = keyof typeof columnTitles;

/**
 * A card's pipeline template.
 * Each time series assigns its `period` column with the {@link PeriodExpression} it receives,
 * so a chart can split its series before and after each shipped change.
 */
export interface DashboardCard {
  /**
   * Name of the question in Metabase, unique within the dashboard.
   */
  readonly name: string;

  /**
   * What the card measures, for the dashboard's reader.
   */
  readonly description: string;

  /**
   * Collection the pipeline runs on.
   */
  readonly collection: string;

  readonly chart: Chart;

  readonly pipeline: (period: PeriodExpression) => readonly Prisma.InputJsonObject[];
}

/**
 * How Metabase draws a card's rows.
 */
export interface Chart {
  readonly display: 'line' | 'bar';

  /**
   * The column on the x-axis, then the column whose values each draw a series.
   */
  readonly dimensions: readonly [Column, Column];

  /**
   * The column on the y-axis, the one a chart with series can draw.
   */
  readonly metric: Column;

  /**
   * Whether the metric is a ratio, shown as a percentage.
   */
  readonly isPercent?: boolean;

  /**
   * Whether bars stack, as the parts of a total.
   */
  readonly isStacked?: boolean;
}

/**
 * Builds the expression of the period a date falls in: the latest shipped change on or before it,
 * as "since <day> <label>", or "baseline" before the first one, so labels sort chronologically.
 */
export type PeriodExpression = (date: string) => Prisma.InputJsonValue;

/**
 * A card with its pipeline expanded, ready to run.
 */
export interface LoadedCard extends Omit<DashboardCard, 'pipeline'> {
  readonly pipeline: readonly Prisma.InputJsonObject[];
}

/**
 * A band of the dashboard under a heading, its cards laid out row by row.
 * The cards of a row share its width.
 */
export interface DashboardSection<T = DashboardCard> {
  readonly heading: string;

  readonly rows: ReadonlyArray<readonly T[]>;
}

const sections: readonly DashboardSection[] = [
  {
    heading: 'First day',
    rows: [[dayOneLikeRate], [dayOneQualityServed, dayOneDepth, dayOneNewcomerPicks]]
  },
  {
    heading: 'Cohorts',
    rows: [[cohortSize], [dayOneRetention, daySevenRetention, dayThirtyRetention]]
  },
  { heading: 'Daily actives', rows: [[dailyActives, dailyActivesByModVersion]] },
  { heading: 'Algorithms', rows: [[likeRateByAlgorithm]] }
];

/**
 * Expands every card's pipeline with the periods of the given shipped changes.
 */
export function loadSections(
  changes: readonly ShippedChange[] = shippedChanges
): ReadonlyArray<DashboardSection<LoadedCard>> {
  const period = periodExpression(changes);

  return sections.map(section => ({
    heading: section.heading,
    rows: section.rows.map(row => row.map(card => ({ ...card, pipeline: card.pipeline(period) })))
  }));
}

/**
 * The cards of {@link loadSections}, in the dashboard's order.
 */
export function loadCards(
  changes: readonly ShippedChange[] = shippedChanges
): readonly LoadedCard[] {
  return loadSections(changes).flatMap(section => section.rows.flat());
}

function periodExpression(changes: readonly ShippedChange[]): PeriodExpression {
  // Latest first, as `$switch` takes the first matching branch.
  const latestFirst = changes.toSorted((a, b) => b.date.localeCompare(a.date));

  return date => {
    if (!latestFirst.length) {
      return { $literal: 'baseline' };
    }

    return {
      $switch: {
        branches: latestFirst.map(change => ({
          case: { $gte: [date, { $toDate: change.date }] },
          // oxlint-disable-next-line unicorn/no-thenable - a $switch branch, never awaited
          then: `since ${change.date.slice(0, 'YYYY-MM-DD'.length)} ${change.label}`
        })),
        default: 'baseline'
      }
    };
  };
}
