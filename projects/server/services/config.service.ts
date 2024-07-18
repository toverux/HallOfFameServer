import { Injectable } from '@nestjs/common';

/**
 * Custom configuration service, we do not use @nestjs/config because Bun
 * already loads dotenv files for us and NestJS solution is not type-safe
 * (more like, the API consumer declares the type).
 */
@Injectable()
export class ConfigService {
    public readonly http = {
        port: ConfigService.getNumber('HOF_HTTP_PORT')
    } as const;

    public readonly azure = {
        url: ConfigService.getString('HOF_AZURE_URL'),
        cdn: ConfigService.getString('HOF_AZURE_CDN'),
        screenshotsContainer: ConfigService.getString(
            'HOF_AZURE_SCREENSHOTS_CONTAINER'
        )
    } as const;

    private static getNumber(envVar: string): number {
        const value = ConfigService.getValue(envVar);
        const number = Number(value);

        if (Number.isNaN(number)) {
            throw new Error(
                `Invalid number in environment variable: ${envVar}`
            );
        }

        return number;
    }

    private static getString(envVar: string): string {
        return ConfigService.getValue(envVar);
    }

    private static getValue(envVar: string): string {
        const value = process.env[envVar];
        if (!value) {
            throw new Error(`Missing environment variable: ${envVar}`);
        }

        return value;
    }
}
