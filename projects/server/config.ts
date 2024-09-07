import { oneLine } from 'common-tags';

/**
 * Custom configuration solution, we do not use @nestjs/config because Bun
 * already loads dotenv files for us and NestJS solution is not type-safe
 * (more like, the API consumer declares the type).
 * Also, we need some values before Nest is initialized, so this is not done in
 * the form of a service.
 */
export const config = {
    env: getEnum('NODE_ENV', ['development', 'production']),

    verbose: process.argv.includes('--verbose') || process.argv.includes('-v'),

    http: {
        address: getString('HOF_HTTP_ADDRESS'),
        port: getNumber('HOF_HTTP_PORT')
    },

    databaseUrl: getString('HOF_DATABASE_URL'),

    azure: {
        url: getString('HOF_AZURE_URL'),
        cdn: getString('HOF_AZURE_CDN'),
        screenshotsContainer: getString('HOF_AZURE_SCREENSHOTS_CONTAINER')
    },

    sentry: {
        dsn: getString('HOF_SENTRY_DSN')
    },

    screenshots: {
        recencyThresholdDays: getNumber(
            'HOF_SCREENSHOTS_RECENCY_THRESHOLD_DAYS'
        ),
        limitPer24h: getNumber('HOF_SCREENSHOTS_LIMIT_PER_24H')
    },

    supportContact: getString('HOF_SUPPORT_CONTACT')
} as const;

function getEnum<const Choices extends string[]>(
    envVar: string,
    choices: Choices
): Choices[number] {
    const value = getString(envVar);

    if (!choices.includes(value)) {
        throw new Error(oneLine`
            Invalid value for environment variable ${envVar},
            got "${value}",
            expected one of: ${choices.join(', ')}.`);
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
