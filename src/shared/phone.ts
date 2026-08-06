/**
 * Phone normalisation (§9).
 *
 * The same person arrives as `+2348012345678`, `08012345678`, `8012345678` or
 * `2348012345678` depending on where they were typed in. Everything is folded
 * to one canonical E.164 form before it is stored or matched, so those four
 * spellings can never become four customer records.
 *
 * Deliberately dependency-free: `libphonenumber` is a large dependency and we
 * only need trunk-prefix handling plus a country dial-code table, which is
 * stable and easy to reason about.
 */

/** Dial codes for the markets the platform operates in, plus common diaspora. */
const DIAL_CODES: Record<string, { code: string; nsnLength: number[] }> = {
  NG: { code: '234', nsnLength: [10] },
  GH: { code: '233', nsnLength: [9] },
  KE: { code: '254', nsnLength: [9] },
  ZA: { code: '27', nsnLength: [9] },
  UG: { code: '256', nsnLength: [9] },
  TZ: { code: '255', nsnLength: [9] },
  RW: { code: '250', nsnLength: [9] },
  CM: { code: '237', nsnLength: [9] },
  CI: { code: '225', nsnLength: [10] },
  SN: { code: '221', nsnLength: [9] },
  EG: { code: '20', nsnLength: [10] },
  US: { code: '1', nsnLength: [10] },
  CA: { code: '1', nsnLength: [10] },
  GB: { code: '44', nsnLength: [10] },
  IN: { code: '91', nsnLength: [10] },
  AE: { code: '971', nsnLength: [9] },
};

/** Longest dial codes first so "234" wins over "23" when both could match. */
const SORTED_CODES = [...new Set(Object.values(DIAL_CODES).map((d) => d.code))].sort(
  (a, b) => b.length - a.length
);

export const DEFAULT_COUNTRY = 'NG';

function digitsOnly(input: string): string {
  return input.replace(/[^\d]/g, '');
}

/**
 * Fold any spelling of a number into E.164 (`+<country><subscriber>`).
 *
 * Returns null when the input can't be a phone number at all, so callers can
 * tell "not provided" from "provided but unusable" rather than silently
 * storing junk.
 */
export function normalizePhone(raw: string | null | undefined, country = DEFAULT_COUNTRY): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const hadPlus = trimmed.startsWith('+') || trimmed.startsWith('00');
  let digits = digitsOnly(trimmed.startsWith('00') ? trimmed.slice(2) : trimmed);
  if (digits.length < 6) return null;

  const home = DIAL_CODES[country.toUpperCase()] ?? DIAL_CODES[DEFAULT_COUNTRY]!;

  // Explicit international form — trust it as given.
  if (hadPlus) return `+${digits}`;

  // National trunk prefix: 080… → 80…
  if (digits.startsWith('0')) {
    digits = digits.replace(/^0+/, '');
    return `+${home.code}${digits}`;
  }

  // Already carries a country code (2348012345678).
  for (const code of SORTED_CODES) {
    if (digits.startsWith(code)) {
      const nsn = digits.slice(code.length);
      // Guard against a subscriber number that merely starts with those digits
      // — 2348012345678 is Nigeria, but 2345678901 is a 10-digit US number.
      const plausible = Object.values(DIAL_CODES)
        .filter((d) => d.code === code)
        .some((d) => d.nsnLength.includes(nsn.length));
      if (plausible) return `+${digits}`;
    }
  }

  // Bare subscriber number in the home country (8012345678).
  if (home.nsnLength.includes(digits.length)) return `+${home.code}${digits}`;

  // Unrecognised shape: keep the digits rather than dropping the contact, but
  // still canonicalise the leading +.
  return `+${digits}`;
}

/**
 * Every spelling a stored number might already have, so a lookup can find
 * records written before normalisation existed.
 */
export function phoneVariants(raw: string | null | undefined, country = DEFAULT_COUNTRY): string[] {
  const normalized = normalizePhone(raw, country);
  if (!normalized) return [];
  const digits = normalized.slice(1);
  const home = DIAL_CODES[country.toUpperCase()] ?? DIAL_CODES[DEFAULT_COUNTRY]!;

  const variants = new Set<string>([normalized, digits]);
  if (digits.startsWith(home.code)) {
    const nsn = digits.slice(home.code.length);
    variants.add(nsn);
    variants.add(`0${nsn}`);
  }
  return [...variants];
}

/** Normalise an email for matching: trimmed, lower-cased, empty → null. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const value = raw?.trim().toLowerCase();
  return value ? value : null;
}

/** Last-4 display form, e.g. for masked confirmation prompts. */
export function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `${'•'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;
}
