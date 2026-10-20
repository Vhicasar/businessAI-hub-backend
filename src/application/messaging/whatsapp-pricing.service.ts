import { getWorkspaceConfig } from '../settings/workspace-config';

/**
 * What a WhatsApp campaign will cost the business at Meta.
 *
 * Meta prices marketing messages per recipient, by the recipient's country and
 * by message category, and it revises those rates on its own schedule. None of
 * that is available through the Cloud API, so this product cannot compute a
 * price from first principles — and inventing one would be worse than saying
 * nothing, because a business would plan around a number we made up.
 *
 * So: rates are supplied by the platform administrator, stamped with the date
 * they were taken from Meta's published pricing, and anything not covered is
 * reported as unavailable rather than estimated. Every figure here is Meta's
 * charge to the business, which is separate from their Vhicasar subscription.
 */

export type MessageCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION' | 'SERVICE';

export interface CountryRate {
  /** ISO 3166-1 alpha-2, uppercase. */
  country: string;
  currency: string;
  marketing: number;
  utility?: number;
  authentication?: number;
}

export interface RateCard {
  rates: CountryRate[];
  /** The day these rates were read from Meta's published pricing. */
  effectiveDate: string;
  /** Where they came from, shown so a business can check them. */
  source: string;
}

export interface CostEstimate {
  available: boolean;
  /** Why no figure is shown, when none is. */
  unavailableReason: string | null;
  currency: string | null;
  total: number | null;
  recipients: number;
  /** Recipients whose country has no rate, so are not in the total. */
  unpriced: number;
  byCountry: { country: string; recipients: number; rate: number | null; subtotal: number | null }[];
  category: MessageCategory;
  effectiveDate: string | null;
  source: string | null;
  assumptions: string[];
}

/** Dial code → ISO country, for the countries a rate card is likely to cover. */
const DIAL_CODES: [string, string][] = [
  ['234', 'NG'], ['233', 'GH'], ['254', 'KE'], ['27', 'ZA'], ['256', 'UG'], ['255', 'TZ'],
  ['20', 'EG'], ['212', 'MA'], ['225', 'CI'], ['221', 'SN'], ['237', 'CM'], ['251', 'ET'],
  ['44', 'GB'], ['353', 'IE'], ['1', 'US'], ['91', 'IN'], ['92', 'PK'], ['971', 'AE'],
  ['966', 'SA'], ['55', 'BR'], ['52', 'MX'], ['62', 'ID'], ['63', 'PH'], ['49', 'DE'],
  ['33', 'FR'], ['34', 'ES'], ['39', 'IT'], ['31', 'NL'], ['61', 'AU'],
];

/** Longest dial code first, so 234 is not mistaken for 23. */
const SORTED_DIAL_CODES = [...DIAL_CODES].sort((a, b) => b[0].length - a[0].length);

export function countryOf(waId: string): string | null {
  const digits = waId.replace(/\D/g, '');
  for (const [code, country] of SORTED_DIAL_CODES) {
    if (digits.startsWith(code)) return country;
  }
  return null;
}

export const whatsappPricingService = {
  /** The administrator's rate card, or null when none has been published. */
  async rateCard(): Promise<RateCard | null> {
    const card = getWorkspaceConfig().whatsappRateCard;
    if (!card?.rates?.length || !card.effectiveDate) return null;
    return card;
  },

  /**
   * Estimate a campaign's Meta charge.
   *
   * Returns `available: false` rather than a number whenever the rates are
   * missing, stale beyond usefulness, or do not cover the recipients — the
   * requirement is to be silent rather than wrong.
   */
  async estimate(waIds: string[], category: MessageCategory = 'MARKETING'): Promise<CostEstimate> {
    const empty: CostEstimate = {
      available: false, unavailableReason: null, currency: null, total: null,
      recipients: waIds.length, unpriced: waIds.length, byCountry: [], category,
      effectiveDate: null, source: null,
      assumptions: [],
    };

    const card = await this.rateCard();
    if (!card) {
      return { ...empty, unavailableReason: 'No WhatsApp rate card has been published by the platform administrator, so no cost can be estimated.' };
    }
    if (category === 'SERVICE') {
      return {
        ...empty,
        unavailableReason: 'Service messages are priced differently and may fall inside Meta\'s free allowance, so no per-message estimate is shown.',
        effectiveDate: card.effectiveDate, source: card.source,
      };
    }

    const counts = new Map<string, number>();
    let unknownCountry = 0;
    for (const waId of waIds) {
      const country = countryOf(waId);
      if (!country) { unknownCountry += 1; continue; }
      counts.set(country, (counts.get(country) ?? 0) + 1);
    }

    const currencies = new Set(card.rates.map((rate) => rate.currency));
    const byCountry: CostEstimate['byCountry'] = [];
    let total = 0;
    let unpriced = unknownCountry;

    for (const [country, recipients] of counts) {
      const rate = card.rates.find((item) => item.country === country);
      const price = rate
        ? category === 'MARKETING' ? rate.marketing
          : category === 'UTILITY' ? rate.utility
          : rate.authentication
        : undefined;
      if (price === undefined) {
        unpriced += recipients;
        byCountry.push({ country, recipients, rate: null, subtotal: null });
        continue;
      }
      const subtotal = price * recipients;
      total += subtotal;
      byCountry.push({ country, recipients, rate: price, subtotal });
    }

    const priced = waIds.length - unpriced;
    if (priced === 0) {
      return {
        ...empty, byCountry, unpriced,
        unavailableReason: 'The published rate card does not cover these recipients\' countries.',
        effectiveDate: card.effectiveDate, source: card.source,
      };
    }
    if (currencies.size > 1) {
      // Summing across currencies would produce a meaningless number.
      return {
        ...empty, byCountry, unpriced,
        unavailableReason: 'The rate card mixes currencies, so a single total cannot be shown. The per-country rates are listed instead.',
        effectiveDate: card.effectiveDate, source: card.source,
      };
    }

    return {
      available: true,
      unavailableReason: null,
      currency: [...currencies][0] ?? null,
      total: Number(total.toFixed(4)),
      recipients: waIds.length,
      unpriced,
      byCountry: byCountry.sort((a, b) => b.recipients - a.recipients),
      category,
      effectiveDate: card.effectiveDate,
      source: card.source,
      assumptions: [
        'Charged by Meta to your own WhatsApp Business Account, separately from your Vhicasar subscription.',
        'Based on each recipient\'s country as derived from their phone number.',
        `Priced as ${category.toLowerCase()} messages; Meta may categorise a message differently.`,
        'Free service messages and other Meta allowances are not deducted.',
        'Meta\'s final charge may differ from this estimate.',
        ...(unpriced > 0 ? [`${unpriced} recipient${unpriced === 1 ? '' : 's'} could not be priced and are excluded from the total.`] : []),
      ],
    };
  },
};
