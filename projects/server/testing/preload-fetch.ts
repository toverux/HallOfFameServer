/**
 * Bun test preload replacing the global `fetch` with the fetch stub for the whole run, reset before
 * every test and verified after it, so a test that sent an unexpected request fails.
 */

import { afterEach, beforeEach } from 'bun:test';
import { fetchStub } from './fetch-stub';

globalThis.fetch = Object.assign(fetchStub.fetch, {
  preconnect: (url: string | URL): never => {
    throw new Error(`Unexpected fetch.preconnect ${String(url)}.`);
  }
});

beforeEach(() => {
  fetchStub.reset();
});

afterEach(() => {
  fetchStub.verify();
});
