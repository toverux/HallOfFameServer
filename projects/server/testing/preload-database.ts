/**
 * Bun test preload creating the run's throwaway database with the schema's indexes,
 * so duplicate-key behavior matches production.
 * It empties the database before every test, and drops it when the run ends.
 */

import { afterAll, beforeEach } from 'bun:test';
import process from 'node:process';
import * as Bun from 'bun';
import { MongoClient } from 'mongodb';
import { allFulfilled } from '../../shared/utils/all-fulfilled';
import { config } from '../config';
import { resetFactorySequences } from './factories';

// Passes the environment explicitly: Bun would otherwise spawn with the one it launched with.
const push = Bun.spawn({
  cmd: ['bun', 'prisma', 'db', 'push', '--skip-generate'],
  env: process.env,
  stdout: 'ignore',
  stderr: 'pipe'
});

if ((await push.exited) != 0) {
  const output = await new Response(push.stderr).text();

  throw new Error(`prisma db push failed, is MongoDB running (mise dev:db:start)?\n${output}`);
}

const mongo = new MongoClient(config.databaseUrl);

const database = mongo.db();

// `db push` created every collection the schema defines.
const collections = await database.collections();

beforeEach(async () => {
  resetFactorySequences();

  // Delete documents rather than drop collections, which would drop the indexes too.
  await allFulfilled(collections.map(collection => collection.deleteMany()));
});

afterAll(async () => {
  await database.dropDatabase();
  await mongo.close();
});
