import type { JsonValue } from '../../shared/utils/json';

/**
 * Stand-in for the global `fetch`, installed for the whole run by the test preload,
 * so no test reaches the network.
 * It answers only the URLs a test told it to expect.
 * Any other request rejects, and fails the test when it ends,
 * even if the caller swallowed the rejection, as `ModService` does.
 */
class FetchStub {
  /**
   * Every requested URL, expected or not, in order.
   */
  public readonly requests: string[] = [];

  private readonly responses = new Map<string, () => Response>();

  private readonly unexpectedRequests: string[] = [];

  public readonly fetch = (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const request = new Request(input, init);

    this.requests.push(request.url);

    const response = this.responses.get(request.url);

    if (!response) {
      const description = `${request.method} ${request.url}`;

      this.unexpectedRequests.push(description);

      return Promise.reject(
        new Error(`Unexpected fetch ${description}, stub it with fetchStub.respondWithJson().`)
      );
    }

    return Promise.resolve(response());
  };

  /**
   * Answers every request to `url` with `body` as JSON.
   */
  public respondWithJson(url: string, body: JsonValue, init?: ResponseInit): void {
    // Normalized as a request's URL is, ex. with a slash after a bare origin.
    this.responses.set(new Request(url).url, () => Response.json(body, init));
  }

  public reset(): void {
    this.requests.length = 0;
    this.responses.clear();
    this.unexpectedRequests.length = 0;
  }

  /**
   * Throws if any request had no expected response, forgetting them.
   */
  public verify(): void {
    const unexpectedRequests = this.unexpectedRequests.splice(0);

    if (unexpectedRequests.length) {
      throw new Error(`Unexpected fetch requests:\n${unexpectedRequests.join('\n')}`);
    }
  }
}

export const fetchStub = new FetchStub();
