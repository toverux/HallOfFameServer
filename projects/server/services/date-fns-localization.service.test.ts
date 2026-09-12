import { describe, expect, test } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import { DateFnsLocalizationService } from './date-fns-localization.service';

describe('DateFnsLocalizationService', () => {
  const localization = new DateFnsLocalizationService();

  describe('getLocaleForRequest', () => {
    // The locales the game ships, as the mod sends them.
    test.each([
      { acceptLanguage: 'en-US', locale: 'en-US' },
      { acceptLanguage: 'de-DE', locale: 'de' },
      { acceptLanguage: 'es-ES', locale: 'es' },
      { acceptLanguage: 'fr-FR', locale: 'fr' },
      { acceptLanguage: 'it-IT', locale: 'it' },
      { acceptLanguage: 'ja-JP', locale: 'ja' },
      { acceptLanguage: 'ko-KR', locale: 'ko' },
      { acceptLanguage: 'pl-PL', locale: 'pl' },
      { acceptLanguage: 'pt-BR', locale: 'pt-BR' },
      { acceptLanguage: 'ru-RU', locale: 'ru' },
      { acceptLanguage: 'zh-HANS', locale: 'zh-CN' },
      { acceptLanguage: 'zh-HANT', locale: 'zh-TW' }
    ])(`maps the game's $acceptLanguage to $locale`, ({ acceptLanguage, locale }) => {
      expect(localeFor(acceptLanguage)).toBe(locale);
    });

    test.each([
      { acceptLanguage: 'fr-CA', locale: 'fr-CA' },
      { acceptLanguage: 'en-GB', locale: 'en-GB' },
      { acceptLanguage: 'zh-HK', locale: 'zh-HK' }
    ])(`prefers the regional locale for $acceptLanguage`, ({ acceptLanguage, locale }) => {
      expect(localeFor(acceptLanguage)).toBe(locale);
    });

    test.each([
      { acceptLanguage: 'fr', locale: 'fr' },
      { acceptLanguage: 'fr-BE', locale: 'fr' },
      { acceptLanguage: 'pt-PT', locale: 'pt' },
      { acceptLanguage: 'en', locale: 'en-US' }
    ])(`falls back to the language's locale for $acceptLanguage`, ({ acceptLanguage, locale }) => {
      expect(localeFor(acceptLanguage)).toBe(locale);
    });

    test.each(['ku-IQ', 'ckb'])(
      `never resolves Central Kurdish, whose code has three letters, from %s`,
      acceptLanguage => {
        expect(localeFor(acceptLanguage)).toBe('en-US');
      }
    );

    test.each(['sr-Latn', 'uz-Cyrl', 'be-tarask', 'ja-Hira'])(
      `never resolves the script variant %s, falling back to en-US`,
      acceptLanguage => {
        expect(localeFor(acceptLanguage)).toBe('en-US');
      }
    );

    test(`resolves a language to its default script, not a script variant`, () => {
      expect(localeFor('sr-RS')).toBe('sr');
    });

    test(`picks the first supported language by quality`, () => {
      expect(localeFor('tlh-KX, de;q=0.8, fr;q=0.9')).toBe('fr');
    });

    test.each([
      { kind: 'no', acceptLanguage: undefined },
      { kind: 'an empty', acceptLanguage: '' },
      { kind: 'an unsupported', acceptLanguage: 'tlh-KX' },
      { kind: 'a malformed', acceptLanguage: 'garbage!!' }
    ])(`falls back to en-US for $kind Accept-Language`, ({ acceptLanguage }) => {
      expect(localeFor(acceptLanguage)).toBe('en-US');
    });
  });

  describe('applyTimezoneOffsetOnDateForRequest', () => {
    const date = new Date('2026-03-14T15:09:26Z');

    // The mod sends the offset in minutes, formatted with the invariant culture.
    test.each([
      { offset: '120', shifted: '2026-03-14T17:09:26.000Z' },
      { offset: '-300', shifted: '2026-03-14T10:09:26.000Z' },
      { offset: '330', shifted: '2026-03-14T20:39:26.000Z' },
      { offset: '0', shifted: '2026-03-14T15:09:26.000Z' },
      { offset: '90.9', shifted: '2026-03-14T16:39:26.000Z' },
      { offset: '-90.9', shifted: '2026-03-14T13:39:26.000Z' }
    ])(`shifts the date by an offset of $offset minutes`, ({ offset, shifted }) => {
      const result = localization.applyTimezoneOffsetOnDateForRequest(
        request({ 'x-timezone-offset': offset }),
        date
      );

      expect(result.toISOString()).toBe(shifted);
    });

    test.each<{ kind: string; headers: FastifyRequest['headers'] }>([
      { kind: 'no', headers: {} },
      { kind: 'a non-numeric', headers: { 'x-timezone-offset': 'UTC+2' } },
      { kind: 'a repeated', headers: { 'x-timezone-offset': ['120', '60'] } }
    ])(`leaves the date as it is for $kind offset`, ({ headers }) => {
      const result = localization.applyTimezoneOffsetOnDateForRequest(request(headers), date);

      expect(result).toEqual(date);
    });
  });

  function localeFor(acceptLanguage: string | undefined): string | undefined {
    return localization.getLocaleForRequest(request({ 'accept-language': acceptLanguage })).code;
  }
});

/**
 * A request carrying only the given headers, the only part the service reads.
 */
function request(headers: FastifyRequest['headers']): FastifyRequest {
  return { headers } as FastifyRequest;
}
