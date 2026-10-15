import type { JsonValue } from '../../shared/utils/json';

type Handler = (request: Request) => Response | Promise<Response>;

/**
 * Stand-in for the global `fetch`, installed for the whole run by the test preload,
 * so no test reaches the network.
 * It answers only the URLs a test told it to expect.
 * Any other request rejects, and fails the test when it ends,
 * even if the caller swallowed the rejection, as `ModService` does.
 */
class FetchStub {
  /**
   * Every request, expected or not, in order.
   */
  public readonly sentRequests: Request[] = [];

  private readonly responses = new Map<string, () => Response>();

  private readonly handlers = new Map<string, Handler>();

  private readonly unexpectedRequests: string[] = [];

  public readonly fetch = (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const request = new Request(input, init);

    this.sentRequests.push(request);

    const response = this.responses.get(request.url) ?? this.handlerOf(request.url);

    if (!response) {
      const description = `${request.method} ${request.url}`;

      this.unexpectedRequests.push(description);

      return Promise.reject(
        new Error(`Unexpected fetch ${description}, stub it with fetchStub.respondWithJson().`)
      );
    }

    return Promise.resolve(response(request));
  };

  /**
   * Answers every request to `url` with `body` as JSON.
   */
  public respondWithJson(url: string, body: JsonValue, init?: ResponseInit): void {
    // Normalized as a request's URL is, ex. with a slash after a bare origin.
    this.responses.set(new Request(url).url, () => Response.json(body, init));
  }

  /**
   * Answers every request whose URL starts with `baseUrl` with what `handler` returns,
   * for a stateful fake of a whole API.
   * A URL stubbed with {@link respondWithJson} takes precedence.
   */
  public handle(baseUrl: string, handler: Handler): void {
    this.handlers.set(new Request(baseUrl).url, handler);
  }

  /**
   * Every requested URL, expected or not, in order.
   */
  public get requests(): string[] {
    return this.sentRequests.map(request => request.url);
  }

  public reset(): void {
    this.sentRequests.length = 0;
    this.responses.clear();
    this.handlers.clear();
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

  private handlerOf(url: string): Handler | undefined {
    return this.handlers.entries().find(([baseUrl]) => url.startsWith(baseUrl))?.[1];
  }
}

export const fetchStub = new FetchStub();
