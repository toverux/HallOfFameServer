import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { oneLine } from 'common-tags';

type RuntimeType = 'server' | 'cli';

let runtimeType: RuntimeType | undefined;

/**
 * Custom configuration solution, we do not use @nestjs/config because Bun already loads dotenv
 * files for us and NestJS solution is not very type-safe.
 * Also, we need some values before Nest is initialized, so this is not done in the form of a
 * service.
 */
export const config = {
  // `test` is forced by the test preload. Most branches compare against the two others, so tests
  // take neither development nor production side effects; crons and log levels branch on `test`.
  env: getEnum('NODE_ENV', ['development', 'production', 'test']),

  get runtimeType(): RuntimeType {
    if (!runtimeType) {
      throw new Error(`Runtime type not set.`);
    }

    return runtimeType;
  },

  verbose: process.argv.includes('--verbose') || process.argv.includes('-v'),

  systemPassword: getString('HOF_SYSTEM_PASSWORD'),

  http: {
    address: getString('HOF_HTTP_ADDRESS'),
    port: getNumber('HOF_HTTP_PORT'),
    baseUrl: getString('HOF_HTTP_BASE_URL'),
    maintenanceMessage: getString('HOF_HTTP_MAINTENANCE_MESSAGE')
  },

  databaseUrl: getString('HOF_DATABASE_URL'),

  azure: {
    url: getString('HOF_AZURE_URL'),
    cdn: getString('HOF_AZURE_CDN'),
    screenshotsContainer: getString('HOF_AZURE_SCREENSHOTS_CONTAINER')
  },

  openAi: {
    apiKey: getString('HOF_OPENAI_API_KEY')
  },

  sentry: {
    dsn: getString('HOF_SENTRY_DSN')
  },

  skyve: {
    apiKey: getString('HOF_SKYVE_API_KEY')
  },

  // The companion variables are read on use, as they may be absent while Discord is disabled;
  // `checkDiscordConfig()` reads them all at boot when it is not.
  discord: {
    /**
     * Whether Discord is on, read on use so a test can switch it off: the bot token's `disabled`
     * value turns it off, as Sentry's DSN does.
     */
    get isEnabled(): boolean {
      return getString('HOF_DISCORD_BOT_TOKEN') != 'disabled';
    },
    get botToken(): string {
      return getString('HOF_DISCORD_BOT_TOKEN');
    },
    get applicationId(): string {
      return getString('HOF_DISCORD_APPLICATION_ID');
    },
    get publicKey(): string {
      return getString('HOF_DISCORD_PUBLIC_KEY');
    },
    get channelId(): string {
      return getString('HOF_DISCORD_CHANNEL_ID');
    },
    /**
     * Discord user IDs of the moderators, comma-separated in the environment.
     */
    get moderatorIds(): readonly string[] {
      return getString('HOF_DISCORD_MODERATOR_IDS')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
    },
    batchCron: getString('HOF_DISCORD_BATCH_CRON'),
    // Fixed in code, so the batch's hour holds through daylight saving and server moves.
    batchTimeZone: 'Europe/Paris'
  },

  // Read on use, as only the environment syncing the dashboards sets them.
  get metabase(): Readonly<{
    url: string;
    apiKey: string;
    databaseId: number;
    collectionId: number;
  }> {
    return {
      url: getString('HOF_METABASE_URL'),
      apiKey: getString('HOF_METABASE_API_KEY'),
      databaseId: getNumber('HOF_METABASE_DATABASE_ID'),
      collectionId: getNumber('HOF_METABASE_COLLECTION_ID')
    };
  },

  screenshots: {
    maxFileSizeBytes: getNumber('HOF_SCREENSHOTS_MAX_FILE_SIZE_MB') * 1000 * 1000,
    jpegQuality: getNumber('HOF_SCREENSHOTS_JPEG_QUALITY'),
    popularScreenshotsMinFavorites: getNumber('HOF_SCREENSHOTS_POPULAR_MIN_FAVORITES'),
    popularScreenshotsPercentile: getNumber('HOF_SCREENSHOTS_POPULAR_PERCENTILE'),
    rankMinUniqueViews: getNumber('HOF_SCREENSHOTS_RANK_MIN_UNIQUE_VIEWS'),
    rankMinFavorites: getNumber('HOF_SCREENSHOTS_RANK_MIN_FAVORITES'),
    newcomerViews: getNumber('HOF_SCREENSHOTS_NEWCOMER_VIEWS'),
    recencyThresholdDays: getNumber('HOF_SCREENSHOTS_RECENCY_THRESHOLD_DAYS'),
    limitPer24h: getNumber('HOF_SCREENSHOTS_LIMIT_PER_24H')
  },

  puppeteer: {
    // Mostly so that Chromium can store cache, but it will also remember devtools preferences etc.,
    // which is nice.
    userDataDir: path.join(os.tmpdir(), 'halloffame/chromium-user-data'),
    args: [
      // Not needed and makes installation more complex
      '--no-sandbox',
      // Needed for image caching to work when we setContent() on a about:blank page.
      '--disable-features=SplitCacheByNetworkIsolationKey'
    ]
  },

  supportContact: getString('HOF_SUPPORT_CONTACT')
} as const;

checkDiscordConfig();

export function setRuntimeType(type: RuntimeType): void {
  if (runtimeType) {
    throw new Error(`Runtime type already set.`);
  }

  runtimeType = type;
}

/**
 * Reads every Discord variable when Discord is on, so a missing companion variable next to a real
 * bot token fails the boot rather than the first post.
 */
function checkDiscordConfig(): void {
  const { discord } = config;

  if (!discord.isEnabled) {
    return;
  }

  // Reading a variable throws when it is missing.
  void [discord.applicationId, discord.publicKey, discord.channelId];

  // Only the parsed list can still come out empty.
  if (!discord.moderatorIds.length) {
    throw new Error(`Missing environment variable: HOF_DISCORD_MODERATOR_IDS`);
  }
}

function getEnum<const Choices extends string[]>(
  envVar: string,
  choices: Choices
): Choices[number] {
  const value = getString(envVar);

  if (!choices.includes(value)) {
    throw new Error(
      oneLine`
      Invalid value for environment variable ${envVar}, got "${value}",
      expected one of: ${choices.join(', ')}.`
    );
  }

  return value;
}

function getNumber(envVar: string): number {
  const value = getValue(envVar);
  const number = Number(value);

  if (Number.isNaN(number)) {
    throw new TypeError(`Invalid number in environment variable: ${envVar}`);
  }

  return number;
}

function getString(envVar: string): string {
  return getValue(envVar);
}

function getValue(envVar: string): string {
  const value = process.env[envVar];
  if (!value) {
    throw new Error(`Missing environment variable: ${envVar}`);
  }

  return value;
}
