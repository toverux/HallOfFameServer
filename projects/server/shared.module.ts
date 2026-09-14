import { type DynamicModule, Module } from '@nestjs/common';
import OpenAi from 'openai';
import { openAiProvider } from './openai-provider';
import { services } from './services';

/**
 * Module used by both the Server and the CLI.
 */
@Module({
  providers: [...services, openAiProvider],
  exports: [...services, OpenAi]
})
export class SharedModule {
  public static forRoot(): DynamicModule {
    return { global: true, module: SharedModule };
  }
}
