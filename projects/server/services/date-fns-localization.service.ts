import { Injectable } from '@nestjs/common';
import * as dfns from 'date-fns';
import * as locales from 'date-fns/locale';
import type { FastifyRequest } from 'fastify';
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

    const offsetInMinutes = Math.trunc(Number(offsetString));

    if (Number.isNaN(offsetInMinutes)) {
      return date;
    }

    return dfns.addMinutes(date, offsetInMinutes);
  }

  private buildLocalesMap(): Map<string, dfns.Locale> {
    const entries = Object.values(locales)
      .map(locale => ({ locale, code: locale.code.toLowerCase() }))
      // Remap "xx" to "xx-xx" codes as resolve-accept-language expects only the latter format, both
      // meaning the same thing.
      .map(({ locale, code }) => ({
        code: code.includes('-') ? code : `${code}-${code}`,
        locale
      }))
      // Keep only the language-country format resolve-accept-language accepts, as any other would
      // fail every lookup: this excludes script variants ("sr-latn") and three-letter languages
      // (ex. "ckb").
      .filter(({ code }) => /^[a-z]{2}-[a-z]{2}$/u.test(code))
      .map(({ code, locale }) => [code, locale] as const);

    return new Map(entries);
  }
}
