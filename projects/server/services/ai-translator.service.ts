import { Inject, Injectable, Logger } from '@nestjs/common';
import { oneLine } from 'common-tags';
import OpenAi from 'openai';
import { z } from 'zod';
import type { Creator } from '#prisma-lib/client';
import type { JsonObject, JsonValue } from '../../shared/utils/json';

export interface TranslationResponse {
  readonly twoLetterLocaleCode: string;
  readonly transliteration: string;
  readonly translation: string;
}

/**
 * Romanization rules for the scripts the general rule serves badly.
 */
export interface ScriptRules {
  readonly name: 'chinese' | 'japanese' | 'korean' | 'cyrillicAndGreek';
  readonly script: RegExp;
  readonly rule: string;
}

/**
 * Transliterates and translates city names and usernames that are in a non-Latin script.
 */
@Injectable()
export class AiTranslatorService {
  private readonly logger = new Logger(AiTranslatorService.name);

  // The prompts are benchmark-tuned: reword them only with the evaluation in
  // docs/adr/0003-translate-names-with-gpt-6-astra.md.
  private static readonly cityIntro = oneLine`
    You transliterate and translate the names players give their cities in a city-building game,
    for players who cannot read the original script.
    A name may be a real place, a foreign place name spelled out phonetically, or an invented
    name.`;

  private static readonly creatorIntro = oneLine`
    You transliterate and translate player usernames from a city-building game, for players who
    cannot read the original script.`;

  private static readonly fieldsIntro = oneLine`
    Fill the fields in order, all three for the same language:`;

  private static readonly localeCodeRule = oneLine`
    - twoLetterLocaleCode: the ISO 639-1 code of the language the name is written in.`;

  private static readonly transliterationRule = oneLine`
    - transliteration: the name romanized with its language's standard system, or its most common
    romanization where there is no standard, so a reader knows how it sounds.
    Capitalize each word, and keep digits, punctuation, emoticons, and decorative symbols as they
    are.`;

  private static readonly cityTranslationRule = oneLine`
    - translation: the name as an English map would print it.
    A real place takes its usual English name (杭州市 becomes Hangzhou).
    A foreign name spelled out phonetically takes its original spelling, guessed from its sounds
    when it matches no real name (洛杉矶 becomes Los Angeles).
    An invented name keeps its name-like parts in romanization without diacritics, translates its
    generic terms, and translates a part only when it reads as ordinary words with a clear meaning
    (永宁市 becomes Yongning City, 翡翠湾 becomes Jade Bay).
    A name nesting places reads from the smallest to the largest, separated by commas (浙江省杭州市
    becomes Hangzhou, Zhejiang Province).`;

  private static readonly creatorTranslationRule = oneLine`
    - translation: the username's meaning in English, short and in title case, with articles,
    conjunctions, and prepositions of up to three letters in lowercase unless first (快乐小猪
    becomes Happy Little Pig).
    A foreign or well-known name, or a play on one, takes its usual English spelling (梅西 becomes
    Messi).
    A name that means nothing, such as a personal name, or whose meaning is uncertain, takes its
    romanization without diacritics.
    Keep emoticons and decorative symbols as they are, and always answer.`;

  private static readonly cityPrompt = [
    AiTranslatorService.cityIntro,
    AiTranslatorService.fieldsIntro,
    AiTranslatorService.localeCodeRule,
    AiTranslatorService.transliterationRule,
    AiTranslatorService.cityTranslationRule
  ].join('\n');

  private static readonly creatorPrompt = [
    AiTranslatorService.creatorIntro,
    AiTranslatorService.fieldsIntro,
    AiTranslatorService.localeCodeRule,
    AiTranslatorService.transliterationRule,
    AiTranslatorService.creatorTranslationRule
  ].join('\n');

  private static readonly scriptRulesIntro = `Rules for the scripts this name uses:`;

  private static readonly closing = `Answer with the raw values, never an explanation.`;

  /**
   * Each enters the prompt only for a name using its script, so a rule never bends another
   * language.
   * Chinese characters alone may be Chinese or Japanese, so they bring both rules.
   */
  private static readonly scriptRules: readonly ScriptRules[] = [
    {
      name: 'chinese',
      script: /\p{Script=Han}/u,
      // The official pinyin orthography, GB/T 16159-2012, spells by words rather than syllables.
      rule: oneLine`
        - Chinese characters: the name is Chinese unless it reads as Japanese, through a Japanese
        name, a character form only Japanese uses (姫, 桜), or kana other than a lone の standing
        for 的.
        Romanize Chinese with Hanyu Pinyin and its tone marks, following the official orthography:
        join the syllables of a word, write a generic term such as 市, 省, 区, 岛, 湾, or 湖 as a
        separate word, write a surname apart from the given name, put an apostrophe before a
        syllable starting with a, o, or e that follows another, write particles such as de and le
        in lowercase, write the · between the parts of a name as a space, and separate a digit
        from the syllable before it (杭州市 becomes Hángzhōu Shì, 西安 becomes Xī'ān).`
    },
    {
      name: 'japanese',
      script: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
      rule: oneLine`
        - Japanese: romanize with Hepburn and its long-vowel macrons, with particles in lowercase
        (大阪の春 becomes Ōsaka no Haru).`
    },
    {
      name: 'korean',
      script: /\p{Script=Hangul}/u,
      rule: oneLine`
        - Korean: romanize with the Revised Romanization, keeping a surname's customary spelling
        (김민수 becomes Kim Minsu).`
    },
    {
      name: 'cyrillicAndGreek',
      script: /[\p{Script=Cyrillic}\p{Script=Greek}]/u,
      rule: oneLine`
        - Cyrillic and Greek: romanize with the language's most common romanization, keeping the
        letters with diacritics of its own Latin alphabet, without stress marks (Serbian Чачак
        becomes Čačak, Greek Αθήνα becomes Athina).
        A name imitating Latin text with lookalike letters (НОРЕ for HOPE) is that Latin text, in
        all three fields.`
    }
  ];

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
      text.trim() != '' &&
      // Match any text with non-Latin characters.
      AiTranslatorService.nonLatinTextRegex.test(text) &&
      // Ignore mixed-script text, for example, some people put the translation themselves or do
      // fancy things with their username; we won't touch those strings.
      !AiTranslatorService.latinTextRegex.test(text)
    );
  }

  public static selectScriptRules(text: string): readonly ScriptRules[] {
    return AiTranslatorService.scriptRules.filter(rules => rules.script.test(text));
  }

  public translateCityName(options: {
    input: string;
    creatorId: Creator['id'];
  }): Promise<TranslationResponse> {
    return this.translate({ ...options, prompt: AiTranslatorService.cityPrompt });
  }

  public translateCreatorName(options: {
    input: string;
    creatorId: Creator['id'];
  }): Promise<TranslationResponse> {
    return this.translate({ ...options, prompt: AiTranslatorService.creatorPrompt });
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
    this.logger.verbose(`Translating "${input}"`);

    const response = await this.openAi.responses.create({
      model: 'gpt-6-astra',
      reasoning: { effort: 'medium' },
      safety_identifier: creatorId,
      input: [
        { role: 'system', content: AiTranslatorService.composePrompt(prompt, input) },
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
    const responseJson = AiTranslatorService.parseJsonResponse(response.output_text);

    // Make sure the JSON from the model is valid.
    const result = AiTranslatorService.openAiResponseZodSchema.parse(responseJson);

    this.logger.log(
      oneLine`
      Translated "${input}" to "${result.translation}",
      transliteration "${result.transliteration}",
      guessed locale "${result.twoLetterLocaleCode}"
      (${response.id}).`
    );

    this.logger.verbose(response);

    return result;
  }

  private static composePrompt(prompt: string, input: string): string {
    const scriptRules = AiTranslatorService.selectScriptRules(input).map(rules => rules.rule);

    return [
      prompt,
      ...(scriptRules.length ? [AiTranslatorService.scriptRulesIntro, ...scriptRules] : []),
      AiTranslatorService.closing
    ].join('\n');
  }

  private static parseJsonResponse(outputText: string): JsonValue {
    try {
      return JSON.parse(outputText);
    } catch (error) {
      throw new Error(`Invalid JSON response from OpenAI: ${outputText}`, { cause: error });
    }
  }
}
