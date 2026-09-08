/**
 * How many SMS a message actually costs.
 *
 * A "message" is not a billing unit. The network splits anything longer than
 * one segment and charges per segment, and where the boundary falls depends on
 * the characters used: a message that fits in the GSM-7 alphabet gets 160
 * characters, but a single emoji — or a curly quote pasted from Word — forces
 * the whole message into UCS-2 and drops the limit to 70.
 *
 * Getting this wrong is not a rounding error. Quoting a 200-character campaign
 * to 250 people as 250 messages when the network will charge for 500 is a
 * bill the business did not agree to.
 */

/** Characters GSM-7 encodes in one septet. */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/**
 * Characters GSM-7 can carry, but only as two septets — an escape plus the
 * character. A message of 80 square brackets is 160 septets, not 80.
 */
const GSM7_EXTENDED = '^{}\\[~]|€';

const LIMITS = {
  GSM_7BIT: { single: 160, multi: 153 },
  UCS2: { single: 70, multi: 67 },
} as const;

export type SmsEncoding = 'GSM_7BIT' | 'UCS2';

export interface SegmentInfo {
  encoding: SmsEncoding;
  /** Billable characters: GSM-7 extended characters count as two. */
  length: number;
  /** What the network will charge for. Always at least 1, even for "". */
  segments: number;
  /** Characters left before another segment is added. */
  remaining: number;
  /**
   * The character that forced UCS-2, when one did. Worth naming: an invisible
   * curly quote can double a campaign's cost, and "your message contains an
   * emoji" is something the sender can act on.
   */
  forcedUnicodeBy: string | null;
}

/** Whether every character fits GSM-7, and the first one that does not. */
function analyseEncoding(text: string): { encoding: SmsEncoding; offender: string | null } {
  for (const char of text) {
    if (!GSM7_BASIC.includes(char) && !GSM7_EXTENDED.includes(char)) {
      return { encoding: 'UCS2', offender: char };
    }
  }
  return { encoding: 'GSM_7BIT', offender: null };
}

/** Billable length: GSM-7 extended characters take two septets. */
function billableLength(text: string, encoding: SmsEncoding): number {
  if (encoding === 'UCS2') {
    // Counted in UTF-16 code units, which is what the network counts. An emoji
    // outside the basic plane is a surrogate pair and genuinely costs two.
    return text.length;
  }
  let length = 0;
  for (const char of text) {
    length += GSM7_EXTENDED.includes(char) ? 2 : 1;
  }
  return length;
}

/** What one message body will cost to send to one recipient. */
export function segmentsFor(text: string): SegmentInfo {
  const { encoding, offender } = analyseEncoding(text);
  const length = billableLength(text, encoding);
  const limits = LIMITS[encoding];

  // An empty message is still one message as far as the network is concerned;
  // rejecting it is the composer's job, not the meter's.
  if (length === 0) {
    return { encoding, length: 0, segments: 1, remaining: limits.single, forcedUnicodeBy: null };
  }

  const segments =
    length <= limits.single ? 1 : Math.ceil(length / limits.multi);
  const capacity = segments === 1 ? limits.single : segments * limits.multi;

  return {
    encoding,
    length,
    segments,
    remaining: capacity - length,
    forcedUnicodeBy: offender,
  };
}

/**
 * The billable units for a whole send.
 *
 * Segments are counted per recipient because the body may differ per
 * recipient once variables are resolved — "Hi Bo" and "Hi Chukwuemeka" can
 * land either side of a segment boundary, and billing the shorter one for
 * everybody would under-charge Vhicasar and mislead the business.
 */
export function totalSegments(bodies: string[]): number {
  return bodies.reduce((sum, body) => sum + segmentsFor(body).segments, 0);
}
