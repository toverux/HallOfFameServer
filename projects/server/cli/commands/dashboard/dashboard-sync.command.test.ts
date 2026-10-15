import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import { iconsole } from '../../../../shared/iconsole';
import type { JsonObject } from '../../../../shared/utils/json';
import { ensureString, nn } from '../../../../shared/utils/type-assertion';
import { introduction, loadCards } from '../../../dashboards/newcomers/dashboard';
import { fetchStub } from '../../../testing/fetch-stub';
import { createServiceTestingModule } from '../../../testing/testing-module';
import { DashboardSyncCommand } from './dashboard-sync.command';

const metabaseUrl = 'https://metabase.halloffame.invalid';

/**
 * The restricted collection and the database the test environment names.
 */
const parentId = 5;

const databaseId = 2;

describe('dashboard sync', () => {
  let testingModule: TestingModule;

  let command: DashboardSyncCommand;

  let logInfo: Mock<typeof iconsole.info>;

  let metabase: FakeMetabase;

  let collection: FakeItem;

  beforeEach(async () => {
    testingModule = await createServiceTestingModule(DashboardSyncCommand.providers());
    command = testingModule.get(DashboardSyncCommand);
    logInfo = spyOn(iconsole, 'info').mockReturnValue(void 0);

    metabase = new FakeMetabase();

    // Created and restricted by hand, as the sync never creates it.
    collection = metabase.add('collection', 'Newcomers', parentId, {});

    fetchStub.handle(metabaseUrl, request => metabase.handle(request));
  });

  afterEach(async () => {
    logInfo.mockRestore();
    await testingModule.close();
  });

  test(`creates the questions and the dashboard in the restricted collection`, async () => {
    await command.run();

    const cards = loadCards();

    expect(metabase.items.filter(item => item.model == 'card')).toEqual(
      cards.map(card => ({
        id: expect.any(Number),
        model: 'card',
        name: card.name,
        parentId: collection.id,
        body: expect.objectContaining({
          description: card.description,
          display: card.chart.display,
          dataset_query: {
            type: 'native',
            database: databaseId,
            native: { query: JSON.stringify(card.pipeline, null, 2), collection: card.collection }
          }
        })
      }))
    );

    const dashboard = metabase.find('dashboard', 'Newcomers');

    expect(dashboard.parentId).toBe(collection.id);

    const dashcards = nn(dashboard.body.dashcards) as JsonObject[];

    const question = (name: string): number => metabase.find('card', name).id;

    expect(dashcards.map(dashcard => dashcardContent(dashcard))).toEqual([
      introduction,
      `**Shipped changes**\n\nNone yet.`,
      'First day',
      question('Day-1 like rate'),
      question('Day-1 quality served'),
      question('Day-1 depth'),
      question('Day-1 newcomer picks'),
      'Cohorts',
      question('Cohort size'),
      question('D1 retention'),
      question('D7 retention'),
      question('D30 retention'),
      'Daily actives',
      question('Daily actives'),
      question('Daily actives by mod version'),
      'Algorithms',
      question('Like rate by algorithm')
    ]);

    expect(logInfo).toHaveBeenCalledWith(
      expect.stringContaining(`Synced 11 questions to ${metabaseUrl}/dashboard/${dashboard.id}.`)
    );
  });

  test(`updates every question and the dashboard in place on the next run`, async () => {
    await command.run();

    const firstRun = structuredClone(metabase.items);

    const question = metabase.find('card', 'D7 retention');

    question.body = { ...question.body, display: 'table', dataset_query: { type: 'native' } };

    await command.run();

    expect(metabase.items).toEqual(firstRun);
  });

  test(`fails with the name of a question whose pipeline Metabase rejects, writing nothing`, () => {
    const retention = nn(loadCards().find(card => card.name == 'D7 retention'));

    metabase.rejectedQueries.add(JSON.stringify(retention.pipeline, null, 2));

    expect(command.run()).rejects.toThrow(
      `Metabase rejected the pipeline of "D7 retention": Unrecognized pipeline stage name`
    );

    expect(metabase.items).toEqual([collection]);
  });

  test(`fails without the restricted collection before checking any query`, () => {
    metabase.items.length = 0;

    expect(command.run()).rejects.toThrow(
      `Create the "Newcomers" collection in collection ${parentId} and restrict its access first.`
    );

    expect(fetchStub.requests).toEqual([
      `${metabaseUrl}/api/collection/${parentId}/items?models=collection`
    ]);
    expect(metabase.items).toEqual([]);
  });
});

interface FakeItem {
  readonly id: number;

  readonly model: string;

  readonly name: string;

  readonly parentId: number;

  // Mutable, as an update replaces it.
  body: JsonObject;
}

/**
 * In-memory stand-in for the endpoints of the Metabase REST API the sync calls.
 * It answers only requests carrying the test environment's API key.
 * An update replaces the fields it sends, and a dashboard's dashcards whole, as Metabase does.
 */
class FakeMetabase {
  public readonly items: FakeItem[] = [];

  /**
   * Pipelines whose query the database rejects, as sent.
   */
  public readonly rejectedQueries = new Set<string>();

  private nextId = 1;

  public add(model: string, name: string, parent: number, body: JsonObject): FakeItem {
    const item: FakeItem = { id: this.nextId++, model, name, parentId: parent, body };

    this.items.push(item);

    return item;
  }

  public find(model: string, name: string): FakeItem {
    return nn(this.items.find(item => item.model == model && item.name == name));
  }

  public async handle(request: Request): Promise<Response> {
    if (request.headers.get('x-api-key') != 'metabase-inert') {
      return new Response('Unauthenticated', { status: 401 });
    }

    const url = new URL(request.url);

    const body = request.method == 'GET' ? {} : ((await request.json()) as JsonObject);

    const route = `${request.method} ${url.pathname}`;

    if (route == 'POST /api/dataset') {
      const native = body.native as JsonObject;

      return this.rejectedQueries.has(ensureString(native.query))
        ? Response.json(
            { status: 'failed', error: 'Unrecognized pipeline stage name' },
            { status: 400 }
          )
        : Response.json({ status: 'completed' }, { status: 202 });
    }

    const items = /^GET \/api\/collection\/(?<id>\d+)\/items$/u.exec(route);

    if (items) {
      const models = url.searchParams.getAll('models');

      const data = this.items
        .filter(item => item.parentId == Number(items.groups?.id))
        .filter(item => models.includes(item.model))
        .map(({ id, name, model }) => ({ id, name, model }));

      return Response.json({ data });
    }

    const creation = /^POST \/api\/(?<model>collection|card|dashboard)$/u.exec(route);

    if (creation) {
      const item = this.add(
        nn(creation.groups?.model),
        ensureString(body.name),
        Number(body.parent_id ?? body.collection_id),
        body
      );

      return Response.json({ id: item.id });
    }

    const update = /^PUT \/api\/(?<model>card|dashboard)\/(?<id>\d+)$/u.exec(route);

    const item = this.items.find(
      candidate =>
        candidate.model == update?.groups?.model && candidate.id == Number(update.groups.id)
    );

    if (item) {
      item.body = { ...item.body, ...body };

      return Response.json({ id: item.id });
    }

    return new Response('Not found', { status: 404 });
  }
}

/**
 * The text of a text or heading card, or the ID of a question's card.
 */
function dashcardContent(dashcard: JsonObject): unknown {
  const settings = dashcard.visualization_settings as JsonObject;

  return dashcard.card_id ?? settings.text;
}
