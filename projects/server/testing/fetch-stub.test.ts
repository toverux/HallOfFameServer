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

  test(`records each request's headers, in order`, async () => {
    fetchStub.respondWithJson(modUrl, {});

    await fetch(modUrl, { headers: { API_KEY: 'first' } });
    await fetch(modUrl);

    expect(fetchStub.sentRequests.map(request => request.headers.get('API_KEY'))).toEqual([
      'first',
      null
    ]);
  });

  test(`answers a stubbed URL however it is written`, async () => {
    fetchStub.respondWithJson('https://example.com', {});

    const response = await fetch('https://example.com/');

    expect(response.status).toBe(200);
  });

  test(`rejects an unexpected URL, then fails the test even if the rejection was caught`, () => {
    expect(fetch('https://example.com/')).rejects.toThrow(
      `Unexpected fetch GET https://example.com/, stub it with fetchStub.respondWithJson().`
    );

    // Consumes the unexpected request, which would otherwise fail this test in the preload.
    expect(() => fetchStub.verify()).toThrow(
      `Unexpected fetch requests:\nGET https://example.com/`
    );
  });

  test(`forgets expected URLs between tests`, () => {
    expect(fetch(modUrl)).rejects.toThrow(`Unexpected fetch GET ${modUrl}`);

    expect(() => fetchStub.verify()).toThrow();
  });
});
