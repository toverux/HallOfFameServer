import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  defaultStackParser,
  type Event,
  type Exception,
  makeFetchTransport,
  NodeClient,
  Scope,
  withIsolationScope
} from '@sentry/bun';
import { hours, seconds } from '../../shared/utils/duration';
import { nn } from '../../shared/utils/type-assertion';
import { config } from '../config';
import { exceptionOf, parseModStack } from './mod-error-stack';

/**
 * An error report of the mod, as `POST /api/v1/errors` receives it.
 */
export interface ModErrorReport {
  /**
   * `log` for an error the mod logged, `escaped` for one of its exceptions the game's log caught,
   * `ui` for one its UI reported.
   */
  readonly source: 'log' | 'escaped' | 'ui';
  readonly severity?: 'silent' | 'recoverable' | 'fatal' | undefined;
  readonly type?: string | undefined;
  readonly message?: string | undefined;
  /**
   * The stack as the runtime wrote it: Mono's `Exception.ToString()`, or the UI's `error.stack`.
   */
  readonly stack: string;
  readonly context: ModErrorContext;
}

/**
 * What the mod gathers at startup; it leaves out a field it failed to read.
 */
export interface ModErrorContext {
  readonly modVersion: string;
  readonly gameVersion: string;
  readonly debug: boolean;
  readonly platform?: string | undefined;
  readonly wine?: boolean | undefined;
  readonly screenWidth?: number | undefined;
  readonly screenHeight?: number | undefined;
  readonly gpuName?: string | undefined;
  readonly gpuVendor?: string | undefined;
  readonly gpuDriverVersion?: string | undefined;
  readonly locale?: string | undefined;
}

/**
 * Passes the mod's error reports to their own Sentry project, through a client of their own, so the
 * server's client, its DSN, user data collection, and integrations never apply to them.
 */
@Injectable()
export class ModErrorReportService implements OnApplicationShutdown {
  /**
   * The most reports passed on per clock hour, all players together, so a game update breaking
   * every player does not spend the Sentry quota the server's own reporting draws on.
   * It stands in for a rate limit on the project's key, which the Sentry plan lacks.
   */
  public static readonly maxReportsPerHour = 30;

  /**
   * How long a report waits for its delivery to Sentry before the request ends without it.
   */
  private static readonly flushTimeoutSeconds = 5;

  /**
   * Never initialized: `init()` sets up integrations, which it has none of, and installs the
   * process's async context strategy, which belongs to the server's client.
   * Closed at shutdown, which removes the exit listeners it adds to the process.
   */
  private readonly client: NodeClient | undefined;

  // Mutable: the clock hour being counted and its count, reset when the hour changes.
  private currentHour = 0;
  private reportsThisHour = 0;

  public constructor() {
    const dsn = config.sentry.modDsn;

    this.client =
      dsn == 'disabled'
        ? undefined
        : new NodeClient({
            dsn,
            environment: config.env,
            // Through the global `fetch`, as Bun's SDK sends.
            transport: makeFetchTransport,
            stackParser: defaultStackParser,
            integrations: [],
            // The server's host and its module hooks have no place in the mod's reports.
            includeServerName: false,
            enableRuntimeChannelInjection: false
          });
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.client?.close(seconds(ModErrorReportService.flushTimeoutSeconds));
  }

  /**
   * Sends a report to Sentry as the Creator `creatorId`, the public ID, and waits for its delivery,
   * so nothing runs past the request.
   * Drops it with no DSN or past the hourly cap.
   */
  public async report(
    report: ModErrorReport,
    reporter: { readonly creatorId: string; readonly sessionId: string | undefined }
  ): Promise<void> {
    const { client } = this;

    if (!client || !this.withinHourlyCap()) {
      return;
    }

    const scope = new Scope();

    scope.setClient(client);
    scope.setUser({ id: reporter.creatorId });
    scope.setTags(tagsOf(report, reporter.sessionId));
    for (const [name, fields] of Object.entries(contextsOf(report.context))) {
      scope.setContext(name, fields);
    }

    const event = eventOf(report);

    // A fresh isolation scope too, so the request's breadcrumbs and data stay off the event.
    withIsolationScope(new Scope(), () => {
      client.captureEvent(event, {}, scope);
    });

    await client.flush(seconds(ModErrorReportService.flushTimeoutSeconds));
  }

  private withinHourlyCap(): boolean {
    const hour = Math.floor(Date.now() / hours(1));

    if (hour != this.currentHour) {
      this.currentHour = hour;
      this.reportsThisHour = 0;
    }

    this.reportsThisHour++;

    return this.reportsThisHour <= ModErrorReportService.maxReportsPerHour;
  }
}

function eventOf(report: ModErrorReport): Event {
  const parsed = parseModStack(report.source == 'ui' ? 'cohtml' : 'mono', report.stack);

  return {
    level: report.severity == 'fatal' ? 'fatal' : 'error',
    platform: report.source == 'ui' ? 'javascript' : 'csharp',
    release: `HallOfFame@${report.context.modVersion}`,
    // The client would otherwise stamp the server's own runtime, Node's name and version.
    contexts: { runtime: { name: report.source == 'ui' ? 'cohtml' : 'Mono' } },
    exception: { values: parsed ?? [rawExceptionOf(report)] },
    // A stack no parser reads travels whole beside the exception its first line names.
    ...(parsed == null && { extra: { stack: report.stack } }),
    // Sentry would otherwise store the address that sent the event, the server's, as the user's IP.
    sdk: { settings: { infer_ip: 'never' } }
  };
}

function tagsOf(report: ModErrorReport, sessionId: string | undefined): Record<string, string> {
  const { context } = report;

  const tags = {
    source: report.source,
    severity: report.severity,
    session_id: sessionId,
    game_version: context.gameVersion,
    debug: String(context.debug),
    platform: context.platform,
    wine: context.wine == null ? undefined : String(context.wine),
    gpu_vendor: context.gpuVendor,
    locale: context.locale
  };

  return withoutAbsent(tags);
}

/**
 * Sentry's GPU, device, and OS contexts, each holding only the fields the mod read, and left out
 * when it read none.
 */
function contextsOf(context: ModErrorContext): Record<string, Record<string, string | number>> {
  const contexts = {
    gpu: withoutAbsent({
      name: context.gpuName,
      vendor_name: context.gpuVendor,
      driver_version: context.gpuDriverVersion
    }),
    device: withoutAbsent({
      screen_width_pixels: context.screenWidth,
      screen_height_pixels: context.screenHeight
    }),
    os: withoutAbsent({ name: context.platform })
  };

  return Object.fromEntries(
    Object.entries(contexts).filter(([, fields]) => Object.keys(fields).length)
  );
}

function withoutAbsent<T>(record: Readonly<Record<string, T | undefined>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, T] => entry[1] != null)
  );
}

/**
 * The exception of a stack no parser reads: the report's type and message, or its first line's.
 */
function rawExceptionOf(report: ModErrorReport): Exception {
  const firstLine = exceptionOf(nn(report.stack.split(/\r?\n/u, 1)[0]), []);

  const value = report.message ?? firstLine.value;

  return { type: report.type ?? firstLine.type, ...(value != null && { value }) };
}
