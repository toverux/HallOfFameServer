import { Module } from '@nestjs/common';
import OpenAi from 'openai';
import { config } from './config';
import { services } from './services';

/**
 * Module used by both the Server and the CLI.
 */
@Module({
  providers: [
    ...services,
    {
      provide: OpenAi,
      useFactory() {
        return new OpenAi({
          apiKey: config.openAi.apiKey,
          timeout: 30_000
        });
      }
    }
  ],
  exports: [...services, OpenAi]
})
export class SharedModule {}
