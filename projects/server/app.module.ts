import { Module } from '@nestjs/common';
import { SentryModule } from '@sentry/nestjs/setup';
import { controllers } from './controllers';
import { SharedModule } from './shared.module';

@Module({
    controllers,
    imports: [SharedModule, SentryModule.forRoot()]
})
export class AppModule {}
