import { Module } from '@nestjs/common';
import OpenAi from 'openai';
import { config } from './config';
import { services } from './services';

/**
 * @public
 * Module used by both the Server and the CLI.
 */
@Module({
  providers: [
    ...services,
    {
      provide: OpenAi,
      useFactory: () => new OpenAi({ apiKey: config.openAi.apiKey })
    }
  ],
  exports: [...services, OpenAi]
})
export class SharedModule {}
