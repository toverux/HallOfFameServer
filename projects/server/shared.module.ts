import { Module } from '@nestjs/common';
import { services } from './services';

/**
 * Module used by both the Server and the CLI.
 */
@Module({
    providers: services,
    exports: services
})
export class SharedModule {}
