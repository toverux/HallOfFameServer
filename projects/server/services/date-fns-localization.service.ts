import { Injectable } from '@nestjs/common';
import * as dfns from 'date-fns';
import * as locales from 'date-fns/locale';
import { FastifyRequest } from 'fastify';
import { resolveAcceptLanguage } from 'resolve-accept-language';

@Injectable()
export class DateFnsLocalizationService {
  private readonly defaultLocale = locales.enUS;

  private readonly dfnsLocaleByCode: Map<string, dfns.Locale> = this.buildLocalesMap();

  private readonly supportedLocales = Array.from(this.dfnsLocaleByCode.keys());

  /**
   * Gets an appropriate date-fns locale for the given request.
   * If the request does not specify a locale, or the locale is not supported, the
   * {@link defaultLocale} is returned.
   */
  public getLocaleForRequest(req: FastifyRequest): dfns.Locale {
    // If the request does not specify a locale, return the default locale.
    let accepted = req.headers['accept-language'];
    if (!accepted) {
      return this.defaultLocale;
    }

    // Remap some locale codes used by the game to the standard we use.
    accepted = accepted.replace('zh-HANS', 'zh-CN').replace('zh-HANT', 'zh-TW');

    // Resolve the locale based on the accepted languages.
    const locale = resolveAcceptLanguage(accepted, this.supportedLocales, this.defaultLocale.code, {
      matchCountry: true
    });

    // Return the corresponding date-fns locale.
    return this.dfnsLocaleByCode.get(locale.toLowerCase()) ?? this.defaultLocale;
  }

  public applyTimezoneOffsetOnDateForRequest(req: FastifyRequest, date: Date): Date {
    const offsetString = req.headers['x-timezone-offset'];

    if (typeof offsetString != 'string') {
      return date;
    }

    const offsetInMinutes = Number.parseInt(offsetString, 10);

    if (Number.isNaN(offsetInMinutes)) {
      return date;
    }

    return dfns.addMinutes(date, offsetInMinutes);
  }

  private buildLocalesMap(): Map<string, dfns.Locale> {
    const entries = Object.entries(locales)
      .map(([_, locale]) => ({ locale, code: locale.code.toLowerCase() }))
      // Remap locales that are not supported by resolve-accept-language because they use
      // three-letter codes, for now in date-fns this is only the case for "ckb", aka
      // "Central Kurdish".
      .map(({ locale, code }) => ({
        locale,
        code: code == 'ckb' ? 'ku-IQ' : code
      }))
      // Remap "xx" to "xx-xx" codes as resolve-accept-language expects only the latter
      // format, both meaning the same thing.
      .map(({ locale, code }) => ({
        code: code.includes('-') ? code : `${code}-${code}`,
        locale
      }))
      // Exclude script variants, as resolve-accept-language does not support them.
      // “About 99% of all cases can be covered using the language-country format. We could
      // possibly extend script support in the future given a valid use case, but in the
      // meantime, our goal is to keep this library as simple as possible, while providing the
      // best matches.” - resolve-accept-language author.
      .filter(
        ({ code }) =>
          !['cyrl', 'hira', 'latn', 'tarask'].includes(
            // biome-ignore lint/style/noNonNullAssertion: always set in the previous map
            code.split('-')[1]!
          )
      )
      .map(({ code, locale }) => [code, locale] as const);

    return new Map(entries);
  }
}
