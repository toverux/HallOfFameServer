import { beforeAll, describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import { openAiProvider } from '../openai-provider';
import { AiTranslatorService } from './ai-translator.service';

// Sent as OpenAI's safety identifier, marking these calls as coming from the tests.
const creatorId = 'live-test';

describe('AiTranslatorService, against the live OpenAI API', () => {
  let translator: AiTranslatorService;

  beforeAll(async () => {
    const testingModule = await Test.createTestingModule({
      providers: [AiTranslatorService, openAiProvider]
    }).compile();

    translator = testingModule.get(AiTranslatorService);
  });

  describe('city names', () => {
    test(`transliterates to the Latin script and guesses the language`, async () => {
      const result = await translator.translateCityName({ input: '서울', creatorId });

      expect(result.twoLetterLocaleCode).toBe('ko');
      // Text is ineligible for translation once it is all in the Latin script.
      expect(AiTranslatorService.isEligibleForTranslation(result.transliteration)).toBe(false);
    });

    test(`transliterates to pinyin with tone marks, joining the syllables of a word`, async () => {
      // Simplified characters that Japanese does not use, so the language is certainly Chinese.
      const result = await translator.translateCityName({ input: '广州', creatorId });

      expect(result.twoLetterLocaleCode).toBe('zh');
      expect(result.transliteration.normalize('NFC')).toBe('Guǎngzhōu');
    });

    test(`separates and translates the generic terms of a place name`, async () => {
      const result = await translator.translateCityName({
        input: '寒宁西省岸平市西文区',
        creatorId
      });

      expect(result.transliteration.normalize('NFC')).toMatch(/\S Shěng \S.* Shì \S.* Qū$/u);
      expect(result.translation).toContain('Province');
      expect(result.translation).toContain('City');
      expect(result.translation).toContain('District');
    });

    test(`restores the original spelling of a foreign name spelled out phonetically`, async () => {
      const result = await translator.translateCityName({ input: '圣卡洛斯', creatorId });

      expect(result.translation).toBe('San Carlos');
    });

    test(`separates a trailing digit from the name`, async () => {
      const result = await translator.translateCityName({ input: '珊瑚宝地2', creatorId });

      expect(result.transliteration).toEndWith(' 2');
      expect(result.translation).toEndWith(' 2');
    });

    test(`keeps the letters with diacritics of a language's own Latin alphabet`, async () => {
      const result = await translator.translateCityName({ input: 'Бреснички Град', creatorId });

      expect(result.twoLetterLocaleCode).toBe('sr');
      expect(result.transliteration.normalize('NFC')).toBe('Bresnički Grad');
    });
  });

  describe('creator names', () => {
    test(`romanizes without the stress accents of a non-tonal language`, async () => {
      const result = await translator.translateCreatorName({ input: 'Αλέξανδρος', creatorId });

      expect(result.twoLetterLocaleCode).toBe('el');
      expect(result.transliteration).toBe('Alexandros');
    });

    test(`splits a personal name into surname and given name, left untranslated`, async () => {
      const result = await translator.translateCreatorName({ input: '刀关志', creatorId });

      expect(result.twoLetterLocaleCode).toBe('zh');
      expect(result.transliteration.normalize('NFC')).toBe('Dāo Guānzhì');
      expect(result.translation).toBe('Dao Guanzhi');
    });

    test(`writes Japanese particles in lowercase`, async () => {
      const result = await translator.translateCreatorName({ input: '火拳の姫', creatorId });

      expect(result.twoLetterLocaleCode).toBe('ja');
      expect(result.transliteration).toBe('Hiken no Hime');
    });

    test(`translates a play on a well-known name to that name`, async () => {
      // Harry Kane, punning on the Korean spelling of "hurricane".
      const result = await translator.translateCreatorName({ input: '해리케인', creatorId });

      expect(result.translation).toBe('Harry Kane');
    });

    test(`reads lookalike letters from other scripts as the Latin text they imitate`, async () => {
      // Greek nu and iota, then Cyrillic er: "vIp".
      const result = await translator.translateCreatorName({ input: 'νΙр', creatorId });

      expect(result.transliteration.toLowerCase()).toBe('vip');
      expect(result.translation.toLowerCase()).toBe('vip');
    });

    test(`keeps an emoticon as it is`, async () => {
      const input = '(づ￣3￣)づ ❤~';

      const result = await translator.translateCreatorName({ input, creatorId });

      expect(result.transliteration).toBe(input);
    });
  });
});
