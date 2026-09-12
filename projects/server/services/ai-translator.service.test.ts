import { describe, expect, test } from 'bun:test';
import { AiTranslatorService } from './ai-translator.service';

describe('AiTranslatorService.isEligibleForTranslation', () => {
  test.each([
    { script: 'Han', text: '東京' },
    { script: 'Kana', text: 'さっぽろ' },
    { script: 'Hangul', text: '서울' },
    { script: 'Cyrillic', text: 'Москва' },
    { script: 'Greek', text: 'Αθήνα' },
    { script: 'Arabic', text: 'القاهرة' },
    { script: 'Han, with digits and punctuation', text: '新東京 2, 第3区!' }
  ])(`accepts a name in a non-Latin script ($script)`, ({ text }) => {
    expect(AiTranslatorService.isEligibleForTranslation(text)).toBe(true);
  });

  test.each([
    { kind: 'plain Latin', text: 'Paris' },
    { kind: 'Latin with diacritics', text: 'São Paulo' },
    { kind: 'digits and punctuation only', text: '1234 - #5!' },
    { kind: 'blank', text: '   ' },
    { kind: 'empty', text: '' }
  ])(`rejects a name without a non-Latin script ($kind)`, ({ text }) => {
    expect(AiTranslatorService.isEligibleForTranslation(text)).toBe(false);
  });

  test.each(['東京 Tokyo', 'Moskva Москва', 'Mayor 市長'])(
    `rejects a mixed-script name, left as the creator wrote it: "%s"`,
    text => {
      expect(AiTranslatorService.isEligibleForTranslation(text)).toBe(false);
    }
  );
});
