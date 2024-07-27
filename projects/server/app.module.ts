import { Module } from '@nestjs/common';
import { SentryModule } from '@sentry/nestjs/setup';
import { controllers } from './controllers';
import { services } from './services';

@Module({
    controllers,
    providers: services,
    imports: [SentryModule.forRoot()]
})
export class AppModule {}
