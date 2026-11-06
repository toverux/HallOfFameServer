/**
 * Metabase dashboards as versioned MongoDB pipelines.
 * Each dashboard is a {@link Dashboard} descriptor, each card a pipeline run as a Metabase native
 * question on the card's collection, which `dashboard sync` pushes to Metabase.
 * Pipelines hold only JSON values (dates through `$toDate`), so each one serializes as the
 * question's body.
 */

import type { Prisma } from '#prisma-lib/client';

/**
 * A dashboard as `dashboard sync` publishes it.
 */
export interface Dashboard<TColumn extends string = string> {
  /**
   * Name of the dashboard in Metabase, and of the collection holding it and its questions.
   */
  readonly name: string;

  /**
   * Markdown opening the dashboard, on how to read it.
   */
  readonly introduction: string;

  /**
   * Titles of the columns the pipelines output, as the charts and tables show them.
   */
  readonly columnTitles: Readonly<Record<TColumn, string>>;

  /**
   * Changes the cards split their series at, listed beside the introduction.
   * Absent when no card has a period dimension, and the introduction then spans the dashboard.
   */
  readonly shippedChanges?: readonly ShippedChange[];

  readonly sections: ReadonlyArray<DashboardSection<DashboardCard<TColumn>>>;
}

/**
 * A change shipped to players, which starts a new period in the dashboard's series.
 */
export interface ShippedChange {
  /**
   * When the change reached players, an ISO 8601 date or date-time in UTC.
   */
  readonly date: string;

  readonly label: string;
}

/**
 * A card's pipeline template.
 * Each time series of a dashboard with shipped changes assigns its `period` column with the
 * {@link PeriodExpression} it receives, so a chart can split its series before and after each
 * change.
 */
export interface DashboardCard<TColumn extends string = string> {
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

  readonly chart: Chart<TColumn>;

  readonly pipeline: (period: PeriodExpression) => readonly Prisma.InputJsonObject[];
}

/**
 * How Metabase draws a card's rows.
 * A `smartscalar` shows the metric of the last row, with its change since the row before; a
 * `funnel` draws one step per row, in row order.
 */
export interface Chart<TColumn extends string = string> {
  readonly display: 'line' | 'bar' | 'row' | 'funnel' | 'smartscalar';

  /**
   * The column on the x-axis (the categories of a row chart, the steps of a funnel), then the
   * column whose values each draw a series, if any.
   */
  readonly dimensions: readonly [TColumn] | readonly [TColumn, TColumn];

  /**
   * The column on the y-axis, the one a chart with series can draw.
   */
  readonly metric: TColumn;

  /**
   * Whether the metric is a ratio, shown as a percentage.
   */
  readonly isPercent?: boolean;

  /**
   * Whether bars stack, as the parts of a total.
   */
  readonly isStacked?: boolean;

  /**
   * Color of each series, keyed by the value of the series column, in the legend's order.
   */
  readonly seriesColors?: Readonly<Record<string, string>>;
}

/**
 * Builds the expression of the period a date falls in: the latest shipped change on or before it,
 * as "since <day> <label>", or "baseline" before the first one, so labels sort chronologically.
 */
export type PeriodExpression = (date: string) => Prisma.InputJsonValue;

/**
 * A card with its pipeline expanded, ready to run.
 */
export interface LoadedCard<TColumn extends string = string> extends Omit<
  DashboardCard<TColumn>,
  'pipeline'
> {
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

/**
 * Expands every card's pipeline with the periods of the given shipped changes, by default the
 * dashboard's own.
 */
export function loadSections<TColumn extends string>(
  dashboard: Dashboard<TColumn>,
  changes: readonly ShippedChange[] = dashboard.shippedChanges ?? []
): ReadonlyArray<DashboardSection<LoadedCard<TColumn>>> {
  const period = periodExpression(changes);

  return dashboard.sections.map(section => ({
    heading: section.heading,
    rows: section.rows.map(row => row.map(card => ({ ...card, pipeline: card.pipeline(period) })))
  }));
}

/**
 * The cards of {@link loadSections}, in the dashboard's order.
 */
export function loadCards<TColumn extends string>(
  dashboard: Dashboard<TColumn>,
  changes?: readonly ShippedChange[]
): ReadonlyArray<LoadedCard<TColumn>> {
  return loadSections(dashboard, changes).flatMap(section => section.rows.flat());
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
