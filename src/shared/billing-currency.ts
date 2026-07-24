/**
 * What currency do we actually charge this customer in?
 *
 * Two hard constraints shape every rule here:
 *
 * 1. **Paystack only settles a handful of currencies** (and only those the
 *    merchant account is enabled for). GBP, EUR, CAD and AED cannot be charged
 *    through it at all, however much we'd like to display them.
 * 2. **A price is a promise, not a conversion.** We never divide a naira price
 *    by an exchange rate to produce a charge. If there is no price set for a
 *    currency, we do not invent one — we fall back to a currency that *does*
 *    have a real price attached.
 *
 * The consequence, stated plainly: a customer in London sees pounds on the
 * marketing site (an estimate, clearly labelled) but is charged in whatever
 * currency their plan actually has a price in. The pricing page must say so.
 */

/**
 * Currencies Paystack can settle.
 *
 * NOTE: this is the ceiling, not a guarantee — your Paystack account must also
 * be enabled for each one. If it isn't, `initializeTransaction` fails at the
 * API and billing surfaces the error rather than silently charging naira.
 */
export const PAYSTACK_CURRENCIES = ['NGN', 'USD', 'GHS', 'ZAR', 'KES'] as const;
export type PaystackCurrency = (typeof PAYSTACK_CURRENCIES)[number];

export const isChargeable = (code: string): code is PaystackCurrency =>
  (PAYSTACK_CURRENCIES as readonly string[]).includes(code.toUpperCase());

/** Naira is the home currency: Nigerian customers are always billed in it, exactly. */
export const BASE_CHARGE_CURRENCY = 'NGN';

/**
 * Indicative naira-per-US-dollar rate, used ONLY to convert the naira base
 * price into USD for an international customer who has no exact price set.
 *
 * ⚠ This is a hardcoded estimate, not a live FX feed — it drifts. Keep the
 * exposure small: Nigerian customers are never converted (they pay the exact
 * naira price), and the moment you set a real USD price in the admin price book
 * it takes precedence over this. Review periodically, or set explicit USD prices
 * to remove the estimate entirely. Mirrors the marketing site's rate.
 */
export const NGN_PER_USD = 1550;
const toUsd = (ngn: number) => Math.round((ngn / NGN_PER_USD) * 100) / 100;

export interface PriceBook {
  /** ISO-4217 → the price in that currency's major unit. */
  [currency: string]: { monthly: number; yearly: number } | undefined;
}

export interface ResolvedPrice {
  amount: number;
  currency: string;
  /**
   * How we landed here — surfaced to the UI so it can be honest about why a
   * Londoner is being charged in dollars.
   */
  reason: 'exact' | 'usd_fallback' | 'usd_converted' | 'base_fallback' | 'merchant_currency';
}

/** Normalise whatever the admin stored into a usable price book. */
export function toPriceBook(raw: unknown): PriceBook {
  if (!raw || typeof raw !== 'object') return {};
  const out: PriceBook = {};
  for (const [code, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as { monthly?: unknown; yearly?: unknown };
    const monthly = Number(v.monthly);
    const yearly = Number(v.yearly);
    // A price of 0 is meaningful (a free plan); NaN and negatives are not.
    if (!Number.isFinite(monthly) || monthly < 0) continue;
    out[code.toUpperCase()] = {
      monthly,
      yearly: Number.isFinite(yearly) && yearly >= 0 ? yearly : monthly * 12,
    };
  }
  return out;
}

/**
 * Pick the price and currency to charge an organisation.
 *
 * Order:
 *   1. the org's own currency, if Paystack can settle it *and* the plan has a
 *      real price in it (naira for Nigeria, or a specific local price);
 *   2. USD, if a dollar price is set — no conversion;
 *   3. for any *non-Nigerian* org with nothing above, USD converted from the
 *      naira base at the indicative rate — so an international customer is
 *      charged in dollars, not surprised with a naira charge;
 *   4. the plan's base price in its base currency (naira) — the Nigerian case.
 *
 * The consequence, stated plainly: a Nigerian org always pays the exact naira
 * price; everyone else pays USD (an exact USD price if set, otherwise a
 * converted estimate). Set explicit USD prices to remove the estimate.
 */
export function resolvePrice(
  book: PriceBook,
  base: { monthly: number; yearly: number; currency: string },
  orgCurrency: string | null | undefined,
  interval: 'MONTHLY' | 'YEARLY',
): ResolvedPrice {
  const pick = (p: { monthly: number; yearly: number }) => (interval === 'YEARLY' ? p.yearly : p.monthly);
  const want = orgCurrency?.toUpperCase() ?? '';
  const baseAmount = interval === 'YEARLY' ? base.yearly : base.monthly;
  const baseCurrency = base.currency.toUpperCase();

  const own = book[want];
  if (want && isChargeable(want) && own) {
    return { amount: pick(own), currency: want, reason: 'exact' };
  }

  // An exact dollar price beats a conversion.
  const usd = book.USD;
  if (usd && want !== 'USD') {
    return { amount: pick(usd), currency: 'USD', reason: 'usd_fallback' };
  }

  // A non-Nigerian org with no exact price: charge USD, converted from the naira
  // base. Nigerian orgs fall through to the exact naira price below.
  if (want && want !== BASE_CHARGE_CURRENCY && baseCurrency === BASE_CHARGE_CURRENCY) {
    return { amount: toUsd(baseAmount), currency: 'USD', reason: 'usd_converted' };
  }

  return { amount: baseAmount, currency: baseCurrency, reason: 'base_fallback' };
}

/**
 * The currency a customer in `orgCurrency` would actually be charged in.
 * Used by the marketing site to tell the truth next to an estimated price.
 */
export function chargeCurrencyFor(book: PriceBook, _baseCurrency: string, orgCurrency: string): string {
  const want = orgCurrency.toUpperCase();
  // Nigerian customers pay naira; a settleable currency with its own price pays
  // that; everyone else pays USD.
  if (want === BASE_CHARGE_CURRENCY) return BASE_CHARGE_CURRENCY;
  if (isChargeable(want) && book[want]) return want;
  return 'USD';
}
