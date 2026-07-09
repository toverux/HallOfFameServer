import { type DynamicModule, Module } from '@nestjs/common';
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
      useFactory: () => new OpenAi({ apiKey: config.openAi.apiKey })
    }
  ],
  exports: [...services, OpenAi]
})
export class SharedModule {
  public static forRoot(): DynamicModule {
    return { global: true, module: SharedModule };
  }
}
