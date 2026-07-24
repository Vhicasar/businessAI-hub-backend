/**
 * Content-based column detection. Pure — given sample values, work out what a
 * column actually holds, regardless of what its header claims (or whether it
 * has one). Used to suggest a mapping and to warn on obvious mismatches.
 */

export type DetectedType =
  | 'email'
  | 'phone'
  | 'url'
  | 'date'
  | 'currency'
  | 'number'
  | 'boolean'
  | 'fullName'
  | 'text'
  | 'empty';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const URL_RE = /^(https?:\/\/|www\.)[^\s]+$/i;
const BOOL_RE = /^(true|false|yes|no|y|n)$/i;
// Currency: a leading/trailing symbol or code around a number — ₦1,200.50, $10, 45.00 USD
const CURRENCY_RE = /^(?:[₦$€£¥]\s?)?-?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?:\s?(?:usd|ngn|eur|gbp|kes|zar))?$|^-?\d+(?:\.\d+)?\s?(?:usd|ngn|eur|gbp|kes|zar)$/i;
const CURRENCY_MARKER_RE = /[₦$€£¥]|usd|ngn|eur|gbp|kes|zar/i;
const NUMBER_RE = /^-?\d+(?:,\d{3})*(?:\.\d+)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?)?/;
const SLASH_DATE_RE = /^\d{1,4}[/.]\d{1,2}[/.]\d{1,4}$/;
const MONTH_NAME_RE = /^\d{1,2}[\s-](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s-]\d{2,4}$|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{2,4}$/i;

/** Phone: enough digits to be a real number, and only phone-ish characters. */
function isPhone(v: string): boolean {
  if (!/^[+()\d\s.-]+$/.test(v)) return false;
  const digits = v.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  // A plain 4-digit year or small integer isn't a phone number.
  return /[+()\s.-]/.test(v) || digits.length >= 10;
}

function isDate(v: string): boolean {
  if (ISO_DATE_RE.test(v) || MONTH_NAME_RE.test(v)) return true;
  if (SLASH_DATE_RE.test(v)) {
    const parts = v.split(/[/.]/).map(Number);
    // Reject things like 1.5 or 10/200 that aren't plausibly dates.
    return parts.length === 3 && parts.every((p) => Number.isFinite(p));
  }
  return false;
}

/** Classify one cell. */
export function detectValue(raw: string): DetectedType {
  const v = raw.trim();
  if (v === '') return 'empty';
  if (EMAIL_RE.test(v)) return 'email';
  if (URL_RE.test(v)) return 'url';
  if (BOOL_RE.test(v)) return 'boolean';
  if (isDate(v)) return 'date';
  if (isPhone(v)) return 'phone';
  if (CURRENCY_RE.test(v) && CURRENCY_MARKER_RE.test(v)) return 'currency';
  if (NUMBER_RE.test(v)) return 'number';
  // Two-to-four words, no digits, leading capital — reads as a person's full
  // name. The capital matters: without it "some free text here" is a name.
  if (/^\p{Lu}[\p{L}'’.-]*(?:\s+[\p{L}'’.-]+){1,3}$/u.test(v) && !/\d/.test(v)) return 'fullName';
  return 'text';
}

export interface ColumnDetection {
  type: DetectedType;
  /** Share of non-empty samples agreeing with `type` (0-1). */
  confidence: number;
  /** Share of samples that were blank. */
  emptyRatio: number;
}

/**
 * Classify a column from its values by majority vote over non-empty cells.
 * `number` is folded into `currency` when any cell carries a currency marker.
 */
export function detectColumn(values: string[]): ColumnDetection {
  if (values.length === 0) return { type: 'empty', confidence: 0, emptyRatio: 1 };

  const counts = new Map<DetectedType, number>();
  let nonEmpty = 0;
  for (const v of values) {
    const t = detectValue(v);
    if (t === 'empty') continue;
    nonEmpty += 1;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const emptyRatio = (values.length - nonEmpty) / values.length;
  if (nonEmpty === 0) return { type: 'empty', confidence: 0, emptyRatio: 1 };

  // A column of mostly plain numbers with some currency-marked cells is currency.
  const currency = counts.get('currency') ?? 0;
  const number = counts.get('number') ?? 0;
  if (currency > 0 && number > 0) {
    counts.set('currency', currency + number);
    counts.delete('number');
  }

  let best: DetectedType = 'text';
  let bestCount = 0;
  for (const [type, n] of counts) {
    if (n > bestCount) {
      best = type;
      bestCount = n;
    }
  }
  return { type: best, confidence: Math.round((bestCount / nonEmpty) * 100) / 100, emptyRatio: Math.round(emptyRatio * 100) / 100 };
}
