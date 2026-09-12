import { describe, expect, test } from 'bun:test';
import { fetchStub } from './fetch-stub';

const modUrl = 'https://api.paradox-interactive.com/mods?modId=74604&os=Windows';

describe('fetchStub', () => {
  test(`answers an expected URL with its JSON response, and records the request`, async () => {
    const body = { errorMessage: 'This mod version is banned' };

    fetchStub.respondWithJson(modUrl, body, { status: 400 });

    const response = await fetch(modUrl);

    expect(response.status).toBe(400);
    expect(response.json()).resolves.toEqual(body);
    expect(fetchStub.requests).toEqual([modUrl]);
  });

  test(`rejects an unexpected URL, then fails the test even if the rejection was caught`, () => {
    expect(fetch('https://example.com/')).rejects.toThrow(
      'Unexpected fetch GET https://example.com/, stub it with fetchStub.respondWithJson().'
    );

    // Consumes the unexpected request, which would otherwise fail this test in the preload.
    expect(() => fetchStub.verify()).toThrow(
      'Unexpected fetch requests:\nGET https://example.com/'
    );
  });

  test(`forgets expected URLs between tests`, () => {
    expect(fetch(modUrl)).rejects.toThrow(`Unexpected fetch GET ${modUrl}`);

    expect(() => fetchStub.verify()).toThrow();
  });
});
