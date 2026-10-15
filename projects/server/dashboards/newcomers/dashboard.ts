/**
 * The Newcomers dashboard's cards, each a MongoDB pipeline run as a Metabase native question
 * on the card's collection.
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
import { retention } from './retention';
import { type ShippedChange, shippedChanges } from './shipped-changes';

export type { ShippedChange } from './shipped-changes';

/**
 * A card's pipeline template.
 * The loader passes the {@link PeriodExpression} each time series assigns its `period` column
 * with, so every series splits before and after each shipped change.
 */
export interface DashboardCard {
  /**
   * Name of the question in Metabase, unique within the dashboard.
   */
  readonly name: string;

  /**
   * Collection the pipeline runs on.
   */
  readonly collection: string;

  readonly pipeline: (period: PeriodExpression) => readonly Prisma.InputJsonObject[];
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

const cards: readonly DashboardCard[] = [
  cohortSize,
  dayOneLikeRate,
  dayOneDepth,
  dayOneQualityServed,
  retention,
  dayOneNewcomerPicks,
  dailyActives,
  dailyActivesByModVersion,
  likeRateByAlgorithm
];

/**
 * Expands every card's pipeline with the periods of the given shipped changes.
 */
export function loadCards(
  changes: readonly ShippedChange[] = shippedChanges
): readonly LoadedCard[] {
  const period = periodExpression(changes);

  // oxlint-disable-next-line oxc/no-map-spread - a few cards, each spread once
  return cards.map(card => ({ ...card, pipeline: card.pipeline(period) }));
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
