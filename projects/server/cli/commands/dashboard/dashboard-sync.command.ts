import { HttpStatus, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { CommandRunner, SubCommand } from 'nest-commander';
import { z } from 'zod';
import type { Prisma } from '#prisma-lib/client';
import { iconsole } from '../../../../shared/iconsole';
import { nn, unreachable } from '../../../../shared/utils/type-assertion';
import { config } from '../../../config';
import {
  type Chart,
  type Dashboard,
  type DashboardTab,
  type LoadedCard,
  loadTabs,
  type ShippedChange
} from '../../../dashboards/dashboard';
import { featureUsageDashboard } from '../../../dashboards/feature-usage/dashboard';
import { newcomersDashboard } from '../../../dashboards/newcomers/dashboard';

/**
 * The dashboards the sync publishes, by the name its argument takes.
 */
const dashboards: Readonly<Record<string, Dashboard>> = {
  'newcomers': newcomersDashboard,
  'feature-usage': featureUsageDashboard
};

/**
 * A kind of Metabase item the sync reads or writes.
 */
type Model = 'collection' | 'card' | 'dashboard';

/**
 * A collection, question, or dashboard in a Metabase collection.
 */
type Item = z.infer<typeof itemsSchema>['data'][number];

const itemsSchema = z.object({
  data: z.array(z.object({ id: z.int(), name: z.string(), model: z.string() }))
});

const createdSchema = z.object({ id: z.int() });

const dashboardSchema = z.object({ tabs: z.array(z.object({ id: z.int(), name: z.string() })) });

const queryResultSchema = z.object({ status: z.string(), error: z.string().nullish() });

/**
 * Width of Metabase's dashboard grid, in columns.
 */
const gridWidth = 24;

/**
 * Height of a chart's card on the dashboard, in rows.
 */
const chartHeight = 6;

/**
 * Height of a headline number's card, a `smartscalar`, in rows.
 */
const scalarHeight = 3;

/**
 * Width of the introduction beside the "Shipped changes" text card, in columns.
 * Without shipped changes, the introduction spans the grid.
 */
const introductionWidth = 14;

/**
 * Height of the introduction, in rows.
 */
const introductionHeight = 3;

/**
 * Time a Metabase request may take, in milliseconds.
 * It leaves a query check time to run a whole pipeline.
 */
const requestTimeout = 120_000;

@SubCommand({
  name: 'sync',
  arguments: '<dashboard>',
  description: `Pushes a dashboard and its questions to Metabase, updating them in place: ${Object.keys(dashboards).join(', ')}.`
})
export class DashboardSyncCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [DashboardSyncCommand];

  public override async run(args: [string]): Promise<void> {
    const [name] = args;

    const dashboard = Object.hasOwn(dashboards, name) ? dashboards[name] : undefined;

    if (!dashboard) {
      throw new Error(
        `Unknown dashboard "${name}", expected one of: ${Object.keys(dashboards).join(', ')}.`
      );
    }

    const { url, apiKey, databaseId, collectionId: parentId } = config.metabase;

    const metabase = new MetabaseApi(url, apiKey);

    const tabs = loadTabs(dashboard);

    const questions = tabs
      .flatMap(tab => tab.sections.flatMap(section => section.rows.flat()))
      .map(card => ({ card, query: nativeQuery(card, databaseId) }));

    // Created and restricted by hand first, as one created here would inherit the parent's access.
    const collectionId = findItem(
      await metabase.items(parentId, ['collection']),
      'collection',
      dashboard.name
    );

    if (collectionId == null) {
      throw new Error(
        `Create the "${dashboard.name}" collection in collection ${parentId} and restrict its access first.`
      );
    }

    // Before any write, so a rejected pipeline leaves Metabase as it was.
    for (const { card, query } of questions) {
      await metabase.checkQuery(card.name, query);
    }

    const items = await metabase.items(collectionId, ['card', 'dashboard']);

    const cardIds = new Map<string, number>();

    for (const { card, query } of questions) {
      const body = {
        name: card.name,
        description: card.description,
        collection_id: collectionId,
        display: card.chart.display,
        visualization_settings: visualizationSettings(card.chart, dashboard),
        dataset_query: query
      };

      const cardId = findItem(items, 'card', card.name);

      if (cardId == null) {
        cardIds.set(card.name, await metabase.create('card', body));
      } else {
        await metabase.send('PUT', `api/card/${cardId}`, body);

        cardIds.set(card.name, cardId);
      }
    }

    const dashboardId =
      findItem(items, 'dashboard', dashboard.name) ??
      (await metabase.create('dashboard', { name: dashboard.name, collection_id: collectionId }));

    // A tab keeps its ID across syncs, found by name, so links to it hold.
    const { tabs: existingTabs } = dashboardSchema.parse(
      await metabase.send('GET', `api/dashboard/${dashboardId}`)
    );

    const tabIds =
      tabs.length > 1
        ? tabs.map(
            (tab, index) =>
              existingTabs.find(existing => existing.name == tab.name)?.id ?? -1 - index
          )
        : [];

    // Dashcards and tabs left out of the lists are removed, and those with a negative ID created.
    await metabase.send('PUT', `api/dashboard/${dashboardId}`, {
      width: 'full',
      tabs: tabs
        .filter((_, index) => index < tabIds.length)
        .map((tab, index) => ({ id: nn(tabIds[index]), name: tab.name })),
      dashcards: dashcards(dashboard, tabs, { cardIds, tabIds })
    });

    const dashboardUrl = new URL(`dashboard/${dashboardId}`, url);

    iconsole.info(chalk.bold(`Synced ${cardIds.size} questions to ${dashboardUrl}.`));
  }
}

/**
 * Client of the Metabase REST API, authenticated with an API key.
 */
class MetabaseApi {
  private readonly url: string;

  private readonly apiKey: string;

  public constructor(url: string, apiKey: string) {
    this.url = url;
    this.apiKey = apiKey;
  }

  /**
   * Runs a query without saving it, as Metabase runs a question.
   *
   * @throws {Error} Naming the question, when the database rejects the query.
   */
  public async checkQuery(name: string, query: Prisma.InputJsonObject): Promise<void> {
    const response = await this.fetch('POST', 'api/dataset', query);

    // A query the database rejects answers 202 or 400, with the error in the body.
    // oxlint-disable-next-line typescript/no-unsafe-enum-comparison - fetch status number vs enum
    if (!response.ok && response.status != HttpStatus.BAD_REQUEST) {
      throw await responseError('POST', 'api/dataset', response);
    }

    const { status, error } = queryResultSchema.parse(await response.json());

    if (status != 'completed') {
      throw new Error(`Metabase rejected the pipeline of "${name}": ${error}`);
    }
  }

  /**
   * Lists the items of the given models in a collection, archived ones excepted.
   */
  public async items(collectionId: number, models: readonly Model[]): Promise<readonly Item[]> {
    const query = new URLSearchParams(models.map(model => ['models', model]));

    const { data } = itemsSchema.parse(
      await this.send('GET', `api/collection/${collectionId}/items?${query}`)
    );

    return data;
  }

  /**
   * @returns The ID of the created item.
   */
  public async create(model: Model, body: Prisma.InputJsonObject): Promise<number> {
    return createdSchema.parse(await this.send('POST', `api/${model}`, body)).id;
  }

  public async send(method: string, path: string, body?: Prisma.InputJsonObject): Promise<unknown> {
    const response = await this.fetch(method, path, body);

    if (!response.ok) {
      throw await responseError(method, path, response);
    }

    return response.json();
  }

  private fetch(method: string, path: string, body?: Prisma.InputJsonObject): Promise<Response> {
    return fetch(new URL(path, this.url), {
      method,
      headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : null,
      signal: AbortSignal.timeout(requestTimeout)
    });
  }
}

async function responseError(method: string, path: string, response: Response): Promise<Error> {
  return new Error(
    `Metabase answered ${method} ${path} with ${response.status}: ${await response.text()}`
  );
}

/**
 * A card's native MongoDB query, its pipeline indented for reading in Metabase's editor.
 */
function nativeQuery(card: LoadedCard, databaseId: number): Prisma.InputJsonObject {
  return {
    type: 'native',
    database: databaseId,
    native: { query: JSON.stringify(card.pipeline, null, 2), collection: card.collection }
  };
}

function visualizationSettings(chart: Chart, dashboard: Dashboard): Prisma.InputJsonObject {
  const [dimension] = chart.dimensions;

  const { columnTitles, dateColumns = [] } = dashboard;

  const columnSettings = Object.fromEntries(
    Object.entries(columnTitles).map(([column, title]) => [
      JSON.stringify(['name', column]),
      {
        column_title: title,
        ...(chart.isPercent &&
          column == chart.metric && {
            number_style: 'percent',
            decimals: 1
          }),
        // UTC midnights, shown as the day alone, ex. "Nov 9, 2026".
        ...(dateColumns.includes(column) && {
          date_style: 'MMMM D, YYYY',
          date_abbreviate: true,
          time_enabled: null
        })
      }
    ])
  );

  switch (chart.display) {
    case 'smartscalar': {
      return {
        'scalar.field': chart.metric,
        'scalar.comparisons': [{ id: 'previous-value', type: 'previousValue' }],
        'column_settings': columnSettings
      };
    }
    case 'scalar': {
      return { 'scalar.field': chart.metric, 'column_settings': columnSettings };
    }
    case 'funnel': {
      return {
        'funnel.dimension': dimension,
        'funnel.metric': chart.metric,
        'column_settings': columnSettings
      };
    }
    case 'line':
    case 'bar':
    case 'row': {
      return {
        'graph.dimensions': chart.dimensions,
        'graph.metrics': [chart.metric],
        ...(chart.stacking && { 'stackable.stack_type': chart.stacking }),
        ...(chart.display == 'row' && {
          'graph.show_values': true,
          // A normalized stack labels its segments, too small for every value to fit.
          ...(chart.stacking == 'normalized' && { 'graph.label_value_frequency': 'fit' })
        }),
        // Charts title their axes from the column names, not the column titles.
        'graph.x_axis.title_text': nn(columnTitles[dimension]),
        'graph.y_axis.title_text': nn(columnTitles[chart.metric]),
        ...(chart.seriesColors && seriesSettings(chart.seriesColors)),
        'column_settings': columnSettings
      };
    }
    default: {
      return unreachable(chart.display);
    }
  }
}

/**
 * Colors each series, and orders the series of a breakout as listed.
 */
function seriesSettings(colors: Readonly<Record<string, string>>): Prisma.InputJsonObject {
  const entries = Object.entries(colors);

  return {
    'graph.series_order': entries.map(([key, color]) => ({ key, name: key, color, enabled: true })),
    'series_settings': Object.fromEntries(entries.map(([key, color]) => [key, { color }]))
  };
}

/**
 * Lays out each tab: its text cards across the top, then each section under its heading, row by
 * row.
 */
function dashcards(
  dashboard: Dashboard,
  tabs: ReadonlyArray<DashboardTab<LoadedCard>>,
  ids: Readonly<{ cardIds: ReadonlyMap<string, number>; tabIds: readonly number[] }>
): Prisma.InputJsonObject[] {
  const layout = tabs.flatMap((tab, index) => {
    const tabId = ids.tabIds[index];

    const cards = tabLayout(dashboard, tab, { cardIds: ids.cardIds, isFirst: index == 0 });

    // Fresh objects, each set once.
    return tabId == null
      ? cards
      : cards.map(dashcard => Object.assign(dashcard, { dashboard_tab_id: tabId }));
  });

  // Each a new dashcard.
  // oxlint-disable-next-line oxc/no-map-spread - a few dashcards, each spread once
  return layout.map((dashcard, index) => ({ id: -1 - index, ...dashcard }));
}

function tabLayout(
  dashboard: Dashboard,
  tab: DashboardTab<LoadedCard>,
  options: Readonly<{ cardIds: ReadonlyMap<string, number>; isFirst: boolean }>
): Prisma.InputJsonObject[] {
  const { cards: layout, height } = textCards(
    tab.introduction,
    options.isFirst ? dashboard.shippedChanges : undefined
  );

  let row = height;

  for (const section of tab.sections) {
    layout.push(
      virtualCard('heading', section.heading, { row, col: 0, size_x: gridWidth, size_y: 1 })
    );

    row += 1;

    for (const cards of section.rows) {
      const width = gridWidth / cards.length;

      const top = row;

      // Every card stretches to the tallest, so the row leaves no gap under a shorter one.
      const rowHeight = Math.max(
        ...cards.map(card => card.chart.height ?? defaultHeight(card.chart))
      );

      layout.push(
        ...cards.map((card, index) => ({
          card_id: nn(options.cardIds.get(card.name)),
          row: top,
          col: index * width,
          size_x: width,
          size_y: rowHeight,
          parameter_mappings: [],
          visualization_settings: {}
        }))
      );

      row += rowHeight;
    }
  }

  return layout;
}

function defaultHeight(chart: Chart): number {
  return chart.display == 'smartscalar' || chart.display == 'scalar' ? scalarHeight : chartHeight;
}

/**
 * The introduction and, given shipped changes, the "Shipped changes" text card beside it, with the
 * height they take.
 */
function textCards(
  introduction: string,
  shippedChanges: readonly ShippedChange[] | undefined
): { cards: Prisma.InputJsonObject[]; height: number } {
  if (!shippedChanges) {
    const position = { row: 0, col: 0, size_x: gridWidth, size_y: introductionHeight };

    return {
      cards: [virtualCard('text', introduction, position)],
      height: introductionHeight
    };
  }

  const lines = shippedChanges
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .map(change => `- ${change.date.slice(0, 'YYYY-MM-DD'.length)}: ${change.label}`);

  const changesText = [`**Shipped changes**`, lines.length ? lines.join('\n') : `None yet.`];

  // A row holds about two lines of text.
  const height = Math.max(introductionHeight, 2 + Math.ceil(lines.length / 2));

  return {
    cards: [
      virtualCard('text', introduction, {
        row: 0,
        col: 0,
        size_x: introductionWidth,
        size_y: height
      }),
      virtualCard('text', changesText.join('\n\n'), {
        row: 0,
        col: introductionWidth,
        size_x: gridWidth - introductionWidth,
        size_y: height
      })
    ],
    height
  };
}

/**
 * A text or heading card, which no question backs.
 */
function virtualCard(
  display: 'text' | 'heading',
  text: string,
  position: Readonly<{ row: number; col: number; size_x: number; size_y: number }>
): Prisma.InputJsonObject {
  return {
    card_id: null,
    ...position,
    parameter_mappings: [],
    visualization_settings: {
      virtual_card: { name: null, display, visualization_settings: {}, archived: false },
      text
    }
  };
}

function findItem(items: readonly Item[], model: Model, name: string): number | undefined {
  return items.find(item => item.model == model && item.name == name)?.id;
}
