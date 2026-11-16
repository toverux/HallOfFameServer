import type { Event } from '@sentry/bun';
import { fetchStub } from './fetch-stub';

/**
 * Sentry's ingestion endpoint for the project of {@link FakeSentryIngest.dsn}, faked at the fetch
 * stub: it keeps the events the server sends, as Sentry receives them after the SDK applied its
 * scopes.
 */
export class FakeSentryIngest {
  public static readonly dsn = 'https://public@sentry.invalid/1';

  public readonly events: Event[] = [];

  /**
   * Every envelope's body as sent, to assert that a value appears nowhere in it.
   */
  public readonly envelopes: string[] = [];

  public install(): void {
    fetchStub.handle('https://sentry.invalid/', async request => {
      const envelope = await request.text();

      this.envelopes.push(envelope);

      // A header line, then each item as a header line and a payload line.
      const [, ...items] = envelope.split('\n').filter(Boolean);

      for (let i = 0; i < items.length; i += 2) {
        const header = JSON.parse(items[i] ?? '{}') as { readonly type?: string };

        if (header.type == 'event') {
          this.events.push(JSON.parse(items[i + 1] ?? '{}') as Event);
        }
      }

      return Response.json({});
    });
  }
}
