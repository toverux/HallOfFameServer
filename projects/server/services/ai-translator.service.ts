import { Inject, Injectable } from '@nestjs/common';
import { oneLine } from 'common-tags';
import OpenAi from 'openai';
import { z } from 'zod';
import type { Creator } from '../../../prisma/generated/client';
import type { JsonObject } from '../common';

export interface TranslationResponse {
  readonly twoLetterLocaleCode: string;
  readonly transliteration: string;
  readonly translation: string;
}

/**
 * Transliterates and translates city names and usernames that are in non-Latin script.
 */
@Injectable()
export class AiTranslatorService {
  private static readonly cityNamePrompt = oneLine`
    You are an assistant translating and transliterating city names to English.
    For the twoLetterLocaleCode field, put the locale code of the source language.
    Use tone marks for the transliteration field.`;

  private static readonly creatorNamePrompt = oneLine`
    You are an assistant translating and transliterating usernames.
    For the twoLetterLocaleCode field, put the locale code of the source language.
    Use tone marks for the transliteration field.`;

  /**
   * The schema we want the AI to output, OpenAI supports JSON Schema.
   * To ensure we get good data back, the response is further validated with
   * {@link openAiResponseZodSchema}.
   */
  private static readonly openAiResponseJsonSchema: JsonObject = {
    type: 'object',
    additionalProperties: false,
    required: ['twoLetterLocaleCode', 'transliteration', 'translation'],
    properties: {
      twoLetterLocaleCode: { type: 'string' },
      transliteration: { type: 'string' },
      translation: { type: 'string' }
    }
  };

  /**
   * Represents the schema for validating a translation response from OpenAI.
   * This schema ensures that all required properties are present and non-empty.
   */
  private static readonly openAiResponseZodSchema = z.strictObject({
    twoLetterLocaleCode: z.string().length(2).nonempty(),
    transliteration: z.string().nonempty(),
    translation: z.string().nonempty()
  });

  /**
   * A regular expression that matches text containing characters outside the Latin script, ignoring
   * those Unicode character categories: punctuation, symbols, whitespaces, digits.
   *
   * @see https://www.fileformat.info/info/unicode/category/index.htm
   */
  private static readonly nonLatinTextRegex = /[^\p{Script=Latin}\p{P}\p{S}\s\d]/u;

  private static readonly latinTextRegex = /\p{Script=Latin}/u;

  @Inject(OpenAi)
  private readonly openAi!: OpenAi;

  public static isEligibleForTranslation(text: string): boolean {
    return (
      // Match any text with non-Latin characters.
      AiTranslatorService.nonLatinTextRegex.test(text) &&
      // Ignore mixed-script text, for example some people put the translation themselves or do
      // fancy things with their username, we won't touch those strings.
      !AiTranslatorService.latinTextRegex.test(text)
    );
  }

  public translateCityName(options: {
    input: string;
    creatorId: Creator['id'];
  }): Promise<TranslationResponse> {
    return this.translate({ ...options, prompt: AiTranslatorService.cityNamePrompt });
  }

  public translateCreatorName(options: {
    input: string;
    creatorId: Creator['id'];
  }): Promise<TranslationResponse> {
    return this.translate({ ...options, prompt: AiTranslatorService.creatorNamePrompt });
  }

  private async translate({
    prompt,
    input,
    creatorId
  }: {
    prompt: string;
    input: string;
    creatorId: Creator['id'];
  }): Promise<TranslationResponse> {
    const response = await this.openAi.responses.create({
      model: 'gpt-4o',
      temperature: 0,
      user: creatorId,
      input: [
        { role: 'system', content: prompt },
        { role: 'user', content: input }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'translation',
          strict: true,
          schema: AiTranslatorService.openAiResponseJsonSchema
        }
      }
    });

    // The call above should throw if there is an error, but we check it here just in case.
    if (response.error?.message) {
      throw new Error(response.error.message);
    }

    // Parse the JSON response from the model.
    let translation: string;
    try {
      translation = JSON.parse(response.output_text);
    } catch (error) {
      throw new Error(`Invalid JSON response from OpenAI: "${response.output_text}".`, {
        cause: error
      });
    }

    // Make sure the JSON from the model is valid.
    return AiTranslatorService.openAiResponseZodSchema.parse(translation);
  }
}
