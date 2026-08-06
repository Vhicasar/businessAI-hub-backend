import { prismaUnscoped } from '../../infrastructure/database/prisma';
import {
  FALLBACK_COUNTRY,
  FALLBACK_CURRENCY,
  countryFromLocale,
  countryFromTimezone,
  currencyForCountry,
  isSupportedCurrency,
  SUPPORTED_CURRENCY_CODES,
} from '../../shared/currency';
import { exchangeRates } from '../../shared/exchange-rates';
import { logger } from '../../shared/logger';

/**
 * Signals the app can offer about where the customer is, strongest first (§2).
 *
 * Nothing here is trusted blindly: every one of these comes from the client, so
 * they resolve *defaults*. A saved preference always wins (§2: "If multiple
 * signals conflict, use the customer's saved preference").
 */
export interface LocationSignals {
  /** Only present when the customer granted location permission. */
  gps?: { latitude: number; longitude: number; country?: string; region?: string; city?: string };
  /** MCC-derived country from the SIM. */
  simCountry?: string;
  /** e.g. "en-GB". */
  deviceLocale?: string;
  /** IANA zone, e.g. "Africa/Lagos". */
  timeZone?: string;
  /** Caller IP, resolved server-side. */
  ip?: string;
  /** What the customer agreed to share. */
  consentLevel?: 'NONE' | 'COARSE' | 'PRECISE';
}

export type LocationSource =
  | 'GPS'
  | 'SIM'
  | 'DEVICE_LOCALE'
  | 'IP'
  | 'PROFILE'
  | 'BUSINESS_DEFAULT'
  | 'PREFERENCE';

export interface ResolvedLocale {
  country: string;
  currency: string;
  locale: string;
  timeZone: string | null;
  /**
   * Which signal decided the country. Reported separately from
   * `currencySource` because pinning a currency does not stop the platform
   * detecting where the customer actually is — saying "detected from your
   * saved preference" when the country came from the SIM would be a lie.
   */
  source: LocationSource;
  /** Which signal decided the currency. PREFERENCE when the customer pinned it. */
  currencySource: LocationSource;
  /** True when the customer pinned the currency or locale themselves. */
  isManual: boolean;
  region?: string | null;
  city?: string | null;
}

/**
 * Very small IP → country lookup.
 *
 * A real GeoIP database is a deployment concern, not a code one, so this reads
 * the country from whatever the edge/proxy already resolved (Cloudflare and most
 * load balancers set one of these headers). When nothing is present it simply
 * declines rather than guessing — a wrong country silently changes what
 * currency a customer sees.
 */
export function countryFromRequestHeaders(headers: Record<string, unknown>): string | null {
  const candidates = ['cf-ipcountry', 'x-vercel-ip-country', 'x-geo-country', 'x-country-code'];
  for (const key of candidates) {
    const value = headers[key];
    const code = Array.isArray(value) ? value[0] : value;
    if (typeof code === 'string' && /^[A-Za-z]{2}$/.test(code) && code.toUpperCase() !== 'XX') {
      return code.toUpperCase();
    }
  }
  return null;
}

/** Reverse the detection priority into a single country + why. */
function pickCountry(
  signals: LocationSignals,
  headerCountry: string | null
): { country: string | null; source: LocationSource } {
  if (signals.gps?.country) return { country: signals.gps.country.toUpperCase(), source: 'GPS' };
  if (signals.simCountry) return { country: signals.simCountry.toUpperCase(), source: 'SIM' };

  const fromLocale = countryFromLocale(signals.deviceLocale);
  if (fromLocale) return { country: fromLocale, source: 'DEVICE_LOCALE' };

  if (headerCountry) return { country: headerCountry, source: 'IP' };

  const fromZone = countryFromTimezone(signals.timeZone);
  if (fromZone) return { country: fromZone, source: 'DEVICE_LOCALE' };

  return { country: null, source: 'PROFILE' };
}

export const localization = {
  /**
   * Work out country, currency, locale and time zone for one customer (§2, §5).
   *
   * Detection order is GPS → SIM → device locale → IP → profile → business
   * default, and the customer's own saved preference overrides all of it.
   */
  async resolve(
    vhicasarId: string,
    signals: LocationSignals = {},
    headers: Record<string, unknown> = {}
  ): Promise<ResolvedLocale> {
    const [identity, preference] = await Promise.all([
      prismaUnscoped.vhicasarId.findUnique({
        where: { id: vhicasarId },
        select: { country: true, locale: true },
      }),
      prismaUnscoped.customerPreference.findUnique({ where: { vhicasarId } }),
    ]);

    const headerCountry = countryFromRequestHeaders(headers);
    const detected = pickCountry(signals, headerCountry);

    // Profile, then the customer's first business, then the platform fallback.
    let country = detected.country;
    let source: LocationSource = detected.source;
    if (!country && identity?.country) {
      country = identity.country.toUpperCase();
      source = 'PROFILE';
    }
    if (!country) {
      const link = await prismaUnscoped.customerLink.findFirst({
        where: { vhicasarId, status: 'ACTIVE' },
        select: { organization: { select: { country: true, currency: true } } },
        orderBy: { createdAt: 'asc' },
      });
      if (link?.organization?.country) {
        country = link.organization.country.toUpperCase();
        source = 'BUSINESS_DEFAULT';
      }
    }
    if (!country) {
      country = FALLBACK_COUNTRY;
      source = 'BUSINESS_DEFAULT';
    }

    let currency = currencyForCountry(country) ?? FALLBACK_CURRENCY;
    let currencySource: LocationSource = source;
    let locale = signals.deviceLocale ?? identity?.locale ?? 'en';
    const timeZone = signals.timeZone ?? null;
    let isManual = false;

    // A saved preference is the customer's explicit decision, so it wins over
    // every detected signal (§2) — but only for what they actually chose. The
    // country keeps reporting the signal that found it.
    if (preference) {
      if (preference.currency && isSupportedCurrency(preference.currency)) {
        currency = preference.currency.toUpperCase();
        currencySource = 'PREFERENCE';
        isManual = true;
      }
      if (preference.locale) {
        locale = preference.locale;
        isManual = true;
      }
    }

    return {
      country,
      currency,
      locale,
      timeZone,
      source,
      currencySource,
      isManual,
      region: signals.gps?.region ?? null,
      city: signals.gps?.city ?? null,
    };
  },

  /**
   * Record where the customer is, so the platform notices when they travel (§5).
   *
   * Precision is capped by consent: without PRECISE consent no coordinates are
   * stored at all, and without COARSE not even a city.
   */
  async recordLocation(
    vhicasarId: string,
    signals: LocationSignals,
    headers: Record<string, unknown> = {}
  ) {
    const consent = signals.consentLevel ?? 'NONE';
    const resolved = await this.resolve(vhicasarId, signals, headers);

    const storePrecise = consent === 'PRECISE' && signals.gps;
    const storeCoarse = consent === 'PRECISE' || consent === 'COARSE';

    const data = {
      country: resolved.country,
      region: storeCoarse ? (resolved.region ?? null) : null,
      city: storeCoarse ? (resolved.city ?? null) : null,
      timeZone: resolved.timeZone,
      currency: resolved.currency,
      locale: resolved.locale,
      source: resolved.source,
      consentLevel: consent,
      latitude: storePrecise ? signals.gps!.latitude : null,
      longitude: storePrecise ? signals.gps!.longitude : null,
      detectedAt: new Date(),
    };

    const previous = await prismaUnscoped.customerLocation.findUnique({ where: { vhicasarId } });
    const row = await prismaUnscoped.customerLocation.upsert({
      where: { vhicasarId },
      create: { vhicasarId, ...data },
      update: data,
    });

    // Keep the identity's own country/locale in step, since that is what other
    // services read when no signals are available.
    if (resolved.country && resolved.country !== previous?.country) {
      await prismaUnscoped.vhicasarId
        .update({ where: { id: vhicasarId }, data: { country: resolved.country } })
        .catch((err: unknown) => logger.warn({ err, vhicasarId }, 'Could not sync identity country'));
    }

    return {
      location: row,
      resolved,
      /** True when the customer appears to have moved country since last time. */
      countryChanged: Boolean(previous?.country && previous.country !== resolved.country),
    };
  },

  /**
   * Rates from every supported currency into one target (§2).
   *
   * Fetched as a table rather than per-amount because a screen shows dozens of
   * figures: converting each one over the network would be slow and could show
   * two different rates on the same screen. Currencies with no live rate are
   * reported in `unavailable`, so the app renders those amounts in their own
   * currency instead of inventing a number.
   */
  async ratesInto(targetCurrency: string, sources?: string[]) {
    const target = targetCurrency.toUpperCase();
    const wanted = (sources?.length ? sources : SUPPORTED_CURRENCY_CODES)
      .map((c) => c.toUpperCase())
      .filter((c) => isSupportedCurrency(c));

    const rates: Record<string, number> = { [target]: 1 };
    const unavailable: string[] = [];

    await Promise.all(
      wanted
        .filter((code) => code !== target)
        .map(async (code) => {
          try {
            const c = await exchangeRates.convert(1, code, target);
            rates[code] = c.rate;
          } catch {
            unavailable.push(code);
          }
        })
    );

    return { target, rates, unavailable, asOf: new Date() };
  },

  /**
   * Convert an amount for *display only* (§2).
   *
   * The ledger is untouched: money stays in the currency it was transacted in,
   * and this returns both figures so the app can show the original alongside
   * the converted value.
   */
  async displayAmount(
    amount: number | string,
    sourceCurrency: string,
    targetCurrency: string
  ): Promise<{
    original: { amount: string; currency: string };
    converted: { amount: string; currency: string } | null;
    rate: number | null;
    asOf: Date | null;
    /** Set when conversion was wanted but no rate was available. */
    unavailableReason?: string;
  }> {
    const original = { amount: Number(amount).toFixed(2), currency: sourceCurrency.toUpperCase() };
    if (sourceCurrency.toUpperCase() === targetCurrency.toUpperCase()) {
      return { original, converted: null, rate: 1, asOf: new Date() };
    }
    try {
      const c = await exchangeRates.convert(Number(amount), sourceCurrency, targetCurrency);
      return {
        original,
        converted: { amount: c.amount.toFixed(2), currency: c.currency },
        rate: c.rate,
        asOf: c.asOf,
      };
    } catch (e) {
      // Showing the original is always correct; a stale or invented rate is not.
      return {
        original,
        converted: null,
        rate: null,
        asOf: null,
        unavailableReason: e instanceof Error ? e.message : 'Conversion unavailable',
      };
    }
  },
};
