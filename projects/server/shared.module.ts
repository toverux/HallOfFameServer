import { Module } from '@nestjs/common';
import OpenAI from 'openai';
import { config } from './config';
import { services } from './services';

/**
 * Module used by both the Server and the CLI.
 */
@Module({
  providers: [
    ...services,
    {
      provide: OpenAI,
      useFactory() {
        return new OpenAI({
          apiKey: config.openAi.apiKey,
          timeout: 30_000
        });
      }
    }
  ],
  exports: [...services, OpenAI]
})
export class SharedModule {}
