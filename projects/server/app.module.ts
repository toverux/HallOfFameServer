import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { SentryModule } from '@sentry/nestjs/setup';
import { ApiModule } from './api/api.module';
import { SharedModule } from './shared.module';

@Module({
    imports: [
        SentryModule.forRoot(),
        RouterModule.register([{ path: 'api/v1', module: ApiModule }]),
        SharedModule,
        ApiModule
    ]
})
export class AppModule {}
