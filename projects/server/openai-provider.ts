import type { FactoryProvider } from '@nestjs/common';
import OpenAi from 'openai';
import { config } from './config';

/**
 * The OpenAI client, shared with the live tests so they call the API as production does.
 */
export const openAiProvider: FactoryProvider<OpenAi> = {
  provide: OpenAi,
  useFactory: () => new OpenAi({ apiKey: config.openAi.apiKey })
};
