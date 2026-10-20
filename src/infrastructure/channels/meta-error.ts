import { AppError } from '../../shared/errors';

/**
 * What Meta said, kept intact.
 *
 * The Graph API's numeric `code` is the only thing in a WhatsApp failure worth
 * branching on. The human sentence beside it changes wording between API
 * versions and locales, and the adapter used to keep only that sentence —
 * which made it impossible to tell "this business has no payment method" from
 * "this template was rejected" without reading prose.
 *
 * The distinction matters because the two demand opposite responses: one stops
 * a campaign and asks the business to set up billing with Meta, the other is
 * a content problem they fix in the template.
 */
export interface MetaErrorDetail {
  code: number | null;
  subcode: number | null;
  type: string | null;
  message: string;
  /** Meta's own user-facing title/body, when it supplies one. */
  details: string | null;
  httpStatus: number;
}

export type MetaFailureKind =
  /** Meta will not send until this business adds a payment method. */
  | 'BILLING_REQUIRED'
  /** The token is dead or lacks a permission — reconnect. */
  | 'AUTH'
  /** The template is missing, unapproved, paused or wrong. */
  | 'TEMPLATE'
  /** Slow down and try again. */
  | 'RATE_LIMIT'
  /** This recipient cannot be reached; others still can. */
  | 'RECIPIENT'
  /** Meta's side, or something we do not recognise. */
  | 'TRANSIENT'
  | 'UNKNOWN';

/**
 * Error codes we act on, from Meta's WhatsApp Cloud API error reference.
 *
 * 131042 is the one that matters most here: Meta returns it when the business
 * has no usable payment method on the WhatsApp Business Account. There is no
 * Graph API field that reports payment status, so this error — arriving in
 * response to a real send — is the only reliable indicator Meta offers.
 */
const BILLING_CODES = new Set([131042]);
const AUTH_CODES = new Set([190, 200, 2500, 10]);
const TEMPLATE_CODES = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016, 132068, 132069]);
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056]);
const RECIPIENT_CODES = new Set([131026, 131047, 131051, 131052, 131053]);
const TRANSIENT_CODES = new Set([1, 2, 131000, 131016, 133016]);

export function parseMetaError(json: unknown, httpStatus: number): MetaErrorDetail {
  const error = (json as { error?: Record<string, unknown> } | null)?.error ?? {};
  const data = error.error_data as { details?: unknown } | undefined;
  return {
    code: typeof error.code === 'number' ? error.code : null,
    subcode: typeof error.error_subcode === 'number' ? error.error_subcode : null,
    type: typeof error.type === 'string' ? error.type : null,
    message: typeof error.message === 'string' ? error.message : `HTTP ${httpStatus}`,
    details: typeof data?.details === 'string' ? data.details : null,
    httpStatus,
  };
}

export function classifyMetaFailure(detail: MetaErrorDetail): MetaFailureKind {
  const { code } = detail;
  if (code !== null) {
    if (BILLING_CODES.has(code)) return 'BILLING_REQUIRED';
    if (AUTH_CODES.has(code)) return 'AUTH';
    if (TEMPLATE_CODES.has(code)) return 'TEMPLATE';
    if (RATE_LIMIT_CODES.has(code)) return 'RATE_LIMIT';
    if (RECIPIENT_CODES.has(code)) return 'RECIPIENT';
    if (TRANSIENT_CODES.has(code)) return 'TRANSIENT';
  }
  /*
   * Wording is the last resort, never the first.
   *
   * Meta has shipped the payment failure under more than one code over time,
   * and a campaign that keeps dispatching into a billing wall burns the
   * business's money and their template quality rating. But prose is matched
   * only when the code told us nothing, so a recognised code is never
   * overridden by a sentence that happens to contain the word "payment".
   */
  if (code === null && /payment method|billing|business eligibility payment/i.test(`${detail.message} ${detail.details ?? ''}`)) {
    return 'BILLING_REQUIRED';
  }
  if (detail.httpStatus === 429) return 'RATE_LIMIT';
  if (detail.httpStatus >= 500) return 'TRANSIENT';
  return 'UNKNOWN';
}

/** Whether another attempt could plausibly succeed without someone intervening. */
export function isRetryable(kind: MetaFailureKind): boolean {
  return kind === 'RATE_LIMIT' || kind === 'TRANSIENT';
}

/**
 * A send failure, carrying the classification so callers can branch without
 * re-reading Meta's prose. The raw detail rides in `details` for the log; the
 * message is what a person is shown.
 */
export class MetaSendError extends AppError {
  constructor(
    public readonly kind: MetaFailureKind,
    public readonly detail: MetaErrorDetail,
    message: string,
  ) {
    super('CHANNEL_SEND_FAILED', 502, message, { metaCode: detail.code, metaSubcode: detail.subcode, kind });
  }
}
