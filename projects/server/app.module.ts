import {
    MiddlewareConsumer,
    Module,
    NestMiddleware,
    NestModule,
    ServiceUnavailableException
} from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { SentryModule } from '@sentry/nestjs/setup';
import { ApiModule } from './api/api.module';
import { StandardError } from './common';
import { config } from './config';
import { FastifyLoggerMiddleware } from './fastify';
import { SharedModule } from './shared.module';

@Module({
    imports: [
        SentryModule.forRoot(),
        RouterModule.register([{ path: 'api/v1', module: ApiModule }]),
        SharedModule,
        ApiModule
    ]
})
export class AppModule implements NestModule {
    public configure(consumer: MiddlewareConsumer): void {
        consumer.apply(FastifyLoggerMiddleware).forRoutes('*');
        consumer.apply(MaintenanceMiddleware).forRoutes('api/*');
    }
}

class MaintenanceMiddleware implements NestMiddleware {
    public use(
        _req: unknown,
        _res: unknown,
        next: (error?: unknown) => void
    ): void {
        if (config.http.maintenanceMessage != 'false') {
            throw new MaintenanceModeError(config.http.maintenanceMessage);
        }

        next();
    }
}

class MaintenanceModeError extends StandardError {
    public override httpErrorType = ServiceUnavailableException;

    public constructor(message: string) {
        const explanation =
            message == 'true' ? `Please check back later.` : message;

        super(`Hall of Fame is not available right now. ${explanation}`);
    }
}
