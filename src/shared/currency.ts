/**
 * Vhicasar Hub AI — locale → currency resolution (single source of truth).
 *
 * Used at signup to pick an organisation's currency from the owner's location,
 * and by the web signup form (mirrored client-side) to prefill the picker.
 *
 * Detection is deliberately offline: an IANA timezone comes from the browser
 * (set by the operating system), which is accurate for nearly everyone, costs
 * nothing, needs no third party, and works in dev. It's a *default*, never a
 * lock — the owner can always choose, and can change it later in settings.
 *
 * Naira is the fallback: this is a Nigeria-first product and its plans are
 * priced in NGN, so an undetectable location should land on the currency the
 * customer is actually billed in — not USD, which is merely Prisma's default.
 */

export const FALLBACK_CURRENCY = 'NGN';
export const FALLBACK_COUNTRY = 'NG';

export interface CurrencyDef {
  code: string;
  name: string;
  symbol: string;
  /** Minor units (2 = cents/kobo). Zero-decimal currencies must not be split. */
  decimals: number;
}

/**
 * Currencies we can price and bill in. Kept deliberately short: every entry is
 * a promise that amounts, rounding and symbols render correctly.
 */
export const CURRENCIES: CurrencyDef[] = [
  { code: 'NGN', name: 'Nigerian naira', symbol: '₦', decimals: 2 },
  { code: 'USD', name: 'US dollar', symbol: '$', decimals: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2 },
  { code: 'GBP', name: 'British pound', symbol: '£', decimals: 2 },
  { code: 'GHS', name: 'Ghanaian cedi', symbol: '₵', decimals: 2 },
  { code: 'KES', name: 'Kenyan shilling', symbol: 'KSh', decimals: 2 },
  { code: 'ZAR', name: 'South African rand', symbol: 'R', decimals: 2 },
  { code: 'EGP', name: 'Egyptian pound', symbol: 'E£', decimals: 2 },
  { code: 'XOF', name: 'West African CFA franc', symbol: 'CFA', decimals: 0 },
  { code: 'XAF', name: 'Central African CFA franc', symbol: 'FCFA', decimals: 0 },
  { code: 'CAD', name: 'Canadian dollar', symbol: 'CA$', decimals: 2 },
  { code: 'AUD', name: 'Australian dollar', symbol: 'A$', decimals: 2 },
  { code: 'INR', name: 'Indian rupee', symbol: '₹', decimals: 2 },
  { code: 'AED', name: 'UAE dirham', symbol: 'AED', decimals: 2 },
  { code: 'SAR', name: 'Saudi riyal', symbol: 'SAR', decimals: 2 },
  { code: 'JPY', name: 'Japanese yen', symbol: '¥', decimals: 0 },
  { code: 'CNY', name: 'Chinese yuan', symbol: 'CN¥', decimals: 2 },
  { code: 'BRL', name: 'Brazilian real', symbol: 'R$', decimals: 2 },
];

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

export const isSupportedCurrency = (code: string): boolean => BY_CODE.has(code.toUpperCase());
export const currencyDef = (code: string): CurrencyDef | undefined => BY_CODE.get(code.toUpperCase());
export const SUPPORTED_CURRENCY_CODES = CURRENCIES.map((c) => c.code);

/** ISO-3166 alpha-2 → ISO-4217. Only countries whose currency we support. */
const COUNTRY_CURRENCY: Record<string, string> = {
  NG: 'NGN',
  GH: 'GHS', KE: 'KES', ZA: 'ZAR', EG: 'EGP',
  // CFA zones — same-name francs, different currencies, so they're listed out.
  BJ: 'XOF', BF: 'XOF', CI: 'XOF', GW: 'XOF', ML: 'XOF', NE: 'XOF', SN: 'XOF', TG: 'XOF',
  CM: 'XAF', CF: 'XAF', TD: 'XAF', CG: 'XAF', GQ: 'XAF', GA: 'XAF',
  US: 'USD', EC: 'USD', SV: 'USD', PA: 'USD', ZW: 'USD',
  GB: 'GBP',
  CA: 'CAD', AU: 'AUD', NZ: 'AUD',
  IN: 'INR', AE: 'AED', SA: 'SAR', JP: 'JPY', CN: 'CNY', BR: 'BRL',
  // Eurozone
  AT: 'EUR', BE: 'EUR', CY: 'EUR', DE: 'EUR', EE: 'EUR', ES: 'EUR', FI: 'EUR',
  FR: 'EUR', GR: 'EUR', HR: 'EUR', IE: 'EUR', IT: 'EUR', LT: 'EUR', LU: 'EUR',
  LV: 'EUR', MT: 'EUR', NL: 'EUR', PT: 'EUR', SI: 'EUR', SK: 'EUR',
};

/**
 * IANA timezone → ISO-3166 country.
 *
 * Only zones whose country maps to a currency we support are listed; anything
 * else falls through to the fallback, which is the correct outcome — guessing
 * from a partial match would be worse than saying "we don't know".
 */
const TIMEZONE_COUNTRY: Record<string, string> = {
  'Africa/Lagos': 'NG', 'Africa/Accra': 'GH', 'Africa/Nairobi': 'KE',
  'Africa/Johannesburg': 'ZA', 'Africa/Cairo': 'EG',
  'Africa/Abidjan': 'CI', 'Africa/Dakar': 'SN', 'Africa/Bamako': 'ML',
  'Africa/Ouagadougou': 'BF', 'Africa/Lome': 'TG', 'Africa/Porto-Novo': 'BJ',
  'Africa/Niamey': 'NE', 'Africa/Bissau': 'GW',
  'Africa/Douala': 'CM', 'Africa/Libreville': 'GA', 'Africa/Ndjamena': 'TD',
  'Africa/Brazzaville': 'CG', 'Africa/Bangui': 'CF', 'Africa/Malabo': 'GQ',
  'Africa/Harare': 'ZW',

  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Vienna': 'AT',
  'Europe/Lisbon': 'PT', 'Europe/Athens': 'GR', 'Europe/Helsinki': 'FI',
  'Europe/Zagreb': 'HR', 'Europe/Vilnius': 'LT', 'Europe/Riga': 'LV',
  'Europe/Tallinn': 'EE', 'Europe/Luxembourg': 'LU', 'Europe/Malta': 'MT',
  'Europe/Ljubljana': 'SI', 'Europe/Bratislava': 'SK', 'Europe/Nicosia': 'CY',

  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US',
  'America/Los_Angeles': 'US', 'America/Phoenix': 'US', 'America/Anchorage': 'US',
  'Pacific/Honolulu': 'US', 'America/Detroit': 'US',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA', 'America/Halifax': 'CA',
  'America/Sao_Paulo': 'BR', 'America/Panama': 'PA', 'America/Guayaquil': 'EC',
  'America/El_Salvador': 'SV',

  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Dubai': 'AE',
  'Asia/Riyadh': 'SA', 'Asia/Tokyo': 'JP', 'Asia/Shanghai': 'CN',

  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU', 'Australia/Adelaide': 'AU', 'Pacific/Auckland': 'NZ',
};

/** Country from an IANA timezone, or null when we can't say. */
export function countryFromTimezone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  return TIMEZONE_COUNTRY[tz.trim()] ?? null;
}

/**
 * Country from a BCP-47 locale's region subtag ("en-NG" → NG).
 * A bare language ("en") carries no region and must not be guessed at — "en"
 * is not the United States.
 */
export function countryFromLocale(locale: string | null | undefined): string | null {
  if (!locale) return null;
  const region = locale.trim().replace(/_/g, '-').split('-')[1];
  if (!region || !/^[A-Za-z]{2}$/.test(region)) return null;
  return region.toUpperCase();
}

export function currencyForCountry(country: string | null | undefined): string | null {
  if (!country) return null;
  return COUNTRY_CURRENCY[country.trim().toUpperCase()] ?? null;
}

export interface LocationHints {
  /** IANA timezone from the browser, e.g. "Africa/Lagos". */
  timezone?: string | null;
  /** BCP-47 locale from the browser, e.g. "en-NG". */
  locale?: string | null;
  /** ISO-3166 alpha-2, if the caller already knows it (e.g. a proxy header). */
  country?: string | null;
  /** An explicit choice by the user. Always wins when supported. */
  currency?: string | null;
}

export interface ResolvedLocale {
  currency: string;
  country: string | null;
  timezone: string;
  /** How we arrived at the currency — surfaced so the UI can be honest. */
  source: 'explicit' | 'country' | 'timezone' | 'locale' | 'fallback';
}

/**
 * Resolve an organisation's currency from what we know about the owner.
 *
 * Order: an explicit choice, then a known country, then the browser timezone,
 * then the locale's region, then Naira. The locale is tried *after* the
 * timezone because a Nigerian with their phone in `en-US` is common, whereas
 * a timezone of Africa/Lagos is a much stronger signal of where they are.
 */
export function resolveLocale(hints: LocationHints): ResolvedLocale {
  const timezone = hints.timezone?.trim() || 'UTC';

  if (hints.currency && isSupportedCurrency(hints.currency)) {
    const explicitCountry =
      hints.country?.toUpperCase() ?? countryFromTimezone(timezone) ?? countryFromLocale(hints.locale);
    return {
      currency: hints.currency.toUpperCase(),
      country: explicitCountry ?? null,
      timezone,
      source: 'explicit',
    };
  }

  const candidates: { country: string | null; source: ResolvedLocale['source'] }[] = [
    { country: hints.country?.trim().toUpperCase() ?? null, source: 'country' },
    { country: countryFromTimezone(timezone), source: 'timezone' },
    { country: countryFromLocale(hints.locale), source: 'locale' },
  ];

  for (const c of candidates) {
    const currency = currencyForCountry(c.country);
    if (currency) return { currency, country: c.country, timezone, source: c.source };
  }

  // Location unknown (or a country we don't price in yet) → Naira.
  return {
    currency: FALLBACK_CURRENCY,
    // Don't claim they're in Nigeria just because we're billing them in naira.
    country: candidates.find((c) => c.country)?.country ?? null,
    timezone,
    source: 'fallback',
  };
}

/** Format for display. Uses Intl so each currency's own conventions apply. */
export function formatMoney(amount: number, currency: string, locale = 'en-NG'): string {
  const def = currencyDef(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: def?.decimals ?? 2,
      maximumFractionDigits: def?.decimals ?? 2,
    }).format(amount);
  } catch {
    // Unknown code: never throw in a render path.
    return `${def?.symbol ?? currency.toUpperCase()} ${amount.toLocaleString()}`;
  }
}
