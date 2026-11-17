/**
 * Helpers for the tests of the Metabase dashboards' pipelines, run on the test database.
 */

import { expect } from 'bun:test';
import type { Document, MongoClient } from 'mongodb';
import { nn } from '../../shared/utils/type-assertion';
import { type Dashboard, loadCards } from '../dashboards/dashboard';

const hoursPerDay = 24;

const daysPerWeek = 7;

const hourInMs = 60 * 60 * 1000;

const dayInMs = hoursPerDay * hourInMs;

const weekInMs = daysPerWeek * dayInMs;

/**
 * Runs the pipeline of a dashboard's card by name, checking that every row holds the columns its
 * chart draws.
 */
export async function runDashboardCard(
  mongo: MongoClient,
  dashboard: Dashboard,
  name: string
): Promise<Document[]> {
  const card = nn(loadCards(dashboard).find(candidate => candidate.name == name));

  const rows = await mongo
    .db()
    .collection(card.collection)
    .aggregate([...card.pipeline])
    .toArray();

  const columns = [...card.chart.dimensions, card.chart.metric].filter(
    // A single value draws its metric alone.
    column => card.chart.display != 'scalar' || column == card.chart.metric
  );

  for (const row of rows) {
    expect(columns.filter(column => !(column in row))).toEqual([]);
  }

  return rows;
}

/**
 * The UTC Monday starting the week of a date, by default the week in progress.
 */
export function weekStartOf(date = new Date()): Date {
  const day = Math.floor(date.getTime() / dayInMs) * dayInMs;

  // Sunday is 0, Monday 1.
  return new Date(day - ((new Date(day).getUTCDay() + daysPerWeek - 1) % daysPerWeek) * dayInMs);
}

/**
 * The given number of weeks before the week in progress started, plus the given hours.
 * `weeksAgo(1)` is last Monday's midnight.
 */
export function weeksAgo(weeks: number, hours = 0): Date {
  return new Date(weekStartOf().getTime() - weeks * weekInMs + hours * hourInMs);
}
