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
  env: getEnum('NODE_ENV', ['development', 'production']),

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

  screenshots: {
    maxFileSizeBytes: getNumber('HOF_SCREENSHOTS_MAX_FILE_SIZE_MB') * 1000 * 1000,
    jpegQuality: getNumber('HOF_SCREENSHOTS_JPEG_QUALITY'),
    popularScreenshotsMinFavorites: getNumber('HOF_SCREENSHOTS_POPULAR_MIN_FAVORITES'),
    popularScreenshotsPercentile: getNumber('HOF_SCREENSHOTS_POPULAR_PERCENTILE'),
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

export function setRuntimeType(type: RuntimeType): void {
  if (runtimeType) {
    throw new Error(`Runtime type already set.`);
  }

  runtimeType = type;
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

  return value as Choices[number];
}

function getNumber(envVar: string): number {
  const value = getValue(envVar);
  const number = Number(value);

  if (Number.isNaN(number)) {
    throw new Error(`Invalid number in environment variable: ${envVar}`);
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
