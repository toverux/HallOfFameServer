import { HttpStatus, type Provider } from '@nestjs/common';
import chalk from 'chalk';
import { CommandRunner, SubCommand } from 'nest-commander';
import { z } from 'zod';
import type { Prisma } from '#prisma-lib/client';
import { iconsole } from '../../../../shared/iconsole';
import { nn } from '../../../../shared/utils/type-assertion';
import { config } from '../../../config';
import {
  type Chart,
  columnTitles,
  type DashboardSection,
  dashboardName,
  introduction,
  type LoadedCard,
  loadSections,
  type ShippedChange
} from '../../../dashboards/newcomers/dashboard';
import { shippedChanges } from '../../../dashboards/newcomers/shipped-changes';

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

const queryResultSchema = z.object({ status: z.string(), error: z.string().nullish() });

/**
 * Width of Metabase's dashboard grid, in columns.
 */
const gridWidth = 24;

/**
 * Height of a question's card on the dashboard, in rows.
 */
const cardHeight = 6;

/**
 * Width of the introduction beside the "Shipped changes" text card, in columns.
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
  description: `Pushes the Newcomers dashboard and its questions to Metabase, updating them in place.`
})
export class DashboardSyncCommand extends CommandRunner {
  public static readonly providers: () => Provider[] = () => [DashboardSyncCommand];

  public override async run(): Promise<void> {
    const { url, apiKey, databaseId, collectionId: parentId } = config.metabase;

    const metabase = new MetabaseApi(url, apiKey);

    const sections = loadSections();

    const questions = sections
      .flatMap(section => section.rows.flat())
      .map(card => ({ card, query: nativeQuery(card, databaseId) }));

    // Created and restricted by hand first, as one created here would inherit the parent's access.
    const collectionId = findItem(
      await metabase.items(parentId, ['collection']),
      'collection',
      dashboardName
    );

    if (collectionId == null) {
      throw new Error(
        `Create the "${dashboardName}" collection in collection ${parentId} and restrict its access first.`
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
        visualization_settings: visualizationSettings(card.chart),
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
      findItem(items, 'dashboard', dashboardName) ??
      (await metabase.create('dashboard', { name: dashboardName, collection_id: collectionId }));

    // Dashcards left out of the list are removed, and those with a negative ID created.
    await metabase.send('PUT', `api/dashboard/${dashboardId}`, {
      width: 'full',
      dashcards: dashcards(sections, cardIds, shippedChanges)
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

function visualizationSettings(chart: Chart): Prisma.InputJsonObject {
  return {
    'graph.dimensions': chart.dimensions,
    'graph.metrics': [chart.metric],
    ...(chart.isStacked && { 'stackable.stack_type': 'stacked' }),
    // Charts title their axes from the column names, not the column titles.
    'graph.x_axis.title_text': columnTitles[chart.dimensions[0]],
    'graph.y_axis.title_text': columnTitles[chart.metric],
    'column_settings': Object.fromEntries(
      Object.entries(columnTitles).map(([column, title]) => [
        JSON.stringify(['name', column]),
        {
          column_title: title,
          ...(chart.isPercent &&
            column == chart.metric && {
              number_style: 'percent',
              decimals: 1
            })
        }
      ])
    )
  };
}

/**
 * Lays out the introduction and the "Shipped changes" text card side by side across the top,
 * then each section under its heading, row by row.
 */
function dashcards(
  sections: ReadonlyArray<DashboardSection<LoadedCard>>,
  cardIds: ReadonlyMap<string, number>,
  changes: readonly ShippedChange[]
): Prisma.InputJsonObject[] {
  const lines = changes
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .map(change => `- ${change.date}: ${change.label}`);

  const changesText = [`**Shipped changes**`, lines.length ? lines.join('\n') : `None yet.`];

  // A row holds about two lines of text.
  const textHeight = Math.max(introductionHeight, 2 + Math.ceil(lines.length / 2));

  const layout = [
    virtualCard('text', introduction, {
      row: 0,
      col: 0,
      size_x: introductionWidth,
      size_y: textHeight
    }),
    virtualCard('text', changesText.join('\n\n'), {
      row: 0,
      col: introductionWidth,
      size_x: gridWidth - introductionWidth,
      size_y: textHeight
    })
  ];

  let row = textHeight;

  for (const section of sections) {
    layout.push(
      virtualCard('heading', section.heading, { row, col: 0, size_x: gridWidth, size_y: 1 })
    );

    row += 1;

    for (const cards of section.rows) {
      const width = gridWidth / cards.length;

      const top = row;

      layout.push(
        ...cards.map((card, index) => ({
          card_id: nn(cardIds.get(card.name)),
          row: top,
          col: index * width,
          size_x: width,
          size_y: cardHeight,
          parameter_mappings: [],
          visualization_settings: {}
        }))
      );

      row += cardHeight;
    }
  }

  // Each a new dashcard.
  // oxlint-disable-next-line oxc/no-map-spread - a few dashcards, each spread once
  return layout.map((dashcard, index) => ({ id: -1 - index, ...dashcard }));
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
