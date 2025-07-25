import {
  type MiddlewareConsumer,
  Module,
  type NestMiddleware,
  type NestModule,
  ServiceUnavailableException
} from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { SentryModule } from '@sentry/nestjs/setup';
import { ApiModule } from './api/api.module';
import { StandardError } from './common';
import { config } from './config';
import { FastifyLoggerMiddleware } from './fastify';
import { SharedModule } from './shared.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    SentryModule.forRoot(),
    RouterModule.register([
      { path: 'api/v1', module: ApiModule },
      { path: 'webhooks', module: WebhooksModule }
    ]),
    SharedModule,
    ApiModule,
    WebhooksModule
  ]
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(FastifyLoggerMiddleware).forRoutes('*');
    consumer.apply(MaintenanceMiddleware).forRoutes('api/*path');
  }
}

class MaintenanceMiddleware implements NestMiddleware {
  public use(_req: unknown, _res: unknown, next: (error?: unknown) => void): void {
    if (config.http.maintenanceMessage != 'false') {
      throw new MaintenanceModeError(config.http.maintenanceMessage);
    }

    next();
  }
}

class MaintenanceModeError extends StandardError {
  public override httpErrorType = ServiceUnavailableException;

  public constructor(message: string) {
    const explanation = message == 'true' ? `Please check back later.` : message;

    super(`Hall of Fame is not available right now. ${explanation}`);
  }
}
