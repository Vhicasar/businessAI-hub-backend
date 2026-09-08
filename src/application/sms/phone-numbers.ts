/**
 * Turning what people typed into something a network will accept.
 *
 * Nigerian numbers arrive in every shape a spreadsheet allows: 08030000001,
 * 8030000001, +234 803 000 0001, 234-803-000-0001, and the same number again
 * with a non-breaking space in it. They are all one person, and a campaign
 * that sends to all five forms bills the business five times to annoy one
 * customer.
 *
 * Everything is normalised to E.164 (+234XXXXXXXXXX) so a number can be
 * compared, deduplicated and handed to a provider without further thought.
 */

/** Default country when a number carries no international prefix. */
const DEFAULT_COUNTRY = { dialCode: '234', trunkPrefix: '0', nationalLength: 10 };

export interface NormalizedPhone {
  /** E.164, e.g. +2348030000001. Null when it cannot be salvaged. */
  e164: string | null;
  /** What was originally supplied, for showing next to a rejection. */
  raw: string;
  reason?: string;
}

/**
 * Normalise one number.
 *
 * Deliberately conservative: anything not confidently resolvable is rejected
 * rather than guessed at. A wrong number is worse than a missing one — it
 * costs a segment and reaches a stranger.
 */
export function normalizePhone(raw: string, dialCode = DEFAULT_COUNTRY.dialCode): NormalizedPhone {
  const original = raw ?? '';
  // Strip everything that is not a digit or a leading plus: spaces, dashes,
  // brackets, and the non-breaking spaces spreadsheets love.
  const cleaned = original.replace(/[^\d+]/g, '');
  if (!cleaned) return { e164: null, raw: original, reason: 'No digits' };

  let digits = cleaned.replace(/\D/g, '');

  // 00 is the international prefix in much of the world; treat it as +.
  if (digits.startsWith('00')) digits = digits.slice(2);

  const national = DEFAULT_COUNTRY.nationalLength;

  // Already international for this country: 234XXXXXXXXXX
  if (digits.startsWith(dialCode) && digits.length === dialCode.length + national) {
    return { e164: `+${digits}`, raw: original };
  }
  // National with the trunk prefix: 0XXXXXXXXXX
  if (digits.startsWith(DEFAULT_COUNTRY.trunkPrefix) && digits.length === national + 1) {
    return { e164: `+${dialCode}${digits.slice(1)}`, raw: original };
  }
  // National without it: XXXXXXXXXX
  if (digits.length === national) {
    return { e164: `+${dialCode}${digits}`, raw: original };
  }
  // Some other country, written in full. Accepted as given rather than
  // bent into a Nigerian shape.
  if (cleaned.startsWith('+') && digits.length >= 8 && digits.length <= 15) {
    return { e164: `+${digits}`, raw: original };
  }

  return {
    e164: null,
    raw: original,
    reason:
      digits.length < national
        ? 'Too short to be a phone number'
        : 'Not a number we recognise — check the country code',
  };
}

export interface RecipientResolution<T> {
  /** One entry per unique, valid number. */
  accepted: { e164: string; source: T }[];
  /** Numbers that could not be used, with a reason to show. */
  rejected: { raw: string; reason: string; source: T }[];
  /** Duplicates dropped, so the count shown can be explained. */
  duplicates: number;
}

/**
 * Resolve a recipient list: normalise, reject what cannot be sent, and drop
 * repeats.
 *
 * The first occurrence of a number wins, so a customer record beats a
 * manually typed number for the same person and the send keeps the richer
 * source for variable substitution.
 */
export function resolveRecipients<T>(
  entries: { phone: string; source: T }[],
  dialCode = DEFAULT_COUNTRY.dialCode,
): RecipientResolution<T> {
  const accepted: { e164: string; source: T }[] = [];
  const rejected: { raw: string; reason: string; source: T }[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  for (const entry of entries) {
    const result = normalizePhone(entry.phone, dialCode);
    if (!result.e164) {
      rejected.push({
        raw: entry.phone,
        reason: result.reason ?? 'Invalid number',
        source: entry.source,
      });
      continue;
    }
    if (seen.has(result.e164)) {
      duplicates += 1;
      continue;
    }
    seen.add(result.e164);
    accepted.push({ e164: result.e164, source: entry.source });
  }

  return { accepted, rejected, duplicates };
}
