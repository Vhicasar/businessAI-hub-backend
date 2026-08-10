import { logger } from '../../shared/logger';
import { resolveOrgProvider } from './org-account.service';

/**
 * Ask the gateway what actually happened.
 *
 * A webhook body is a claim made by whoever posted it. The signature proves it
 * came from the gateway; it does not prove the figures inside were not altered
 * by a bug, a replay of an older event, or a partially-written payload. So the
 * amount that gets booked is the one read back from the provider's own API
 * against the reference — never the one in the request.
 */

export interface VerifyInput {
  organizationId: string;
  provider: string;
  reference: string;
  /**
   * The payload's own figures. Used only when the provider API cannot be
   * reached at all, and only after the signature has already been verified —
   * see the note in `verifyWithProvider`.
   */
  fallback?: { amountMinor: number | null; currency: string | null };
}

export type VerifyResult =
  | {
      ok: true;
      amount: number;
      currency: string;
      providerRef: string;
      paidAt: Date | null;
      fee: number | null;
      /** True when the figures came from the payload rather than the API. */
      degraded: boolean;
    }
  | { ok: false; reason: string };

/**
 * Currencies with no minor unit. Gateways quote everything in the smallest
 * unit, and dividing a yen amount by 100 would under-book by 99%.
 */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF', 'UGX', 'RWF']);

export function fromMinorUnits(amountMinor: number, currency: string): number {
  const divisor = ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100;
  return Math.round((amountMinor / divisor) * 100) / 100;
}

export async function verifyWithProvider(input: VerifyInput): Promise<VerifyResult> {
  const provider = await resolveOrgProvider(input.organizationId);

  if (!provider) {
    return {
      ok: false,
      reason: 'The business has no usable payment gateway configured to verify against',
    };
  }
  if (provider.name !== input.provider) {
    // The business has since switched gateways. Booking an old gateway's
    // charge through the new one's credentials would verify nothing.
    return {
      ok: false,
      reason: `Event came from ${input.provider} but the business now collects through ${provider.name}`,
    };
  }

  try {
    const txn = await provider.verifyTransaction(input.reference);
    const status = String(txn.status ?? '').toLowerCase();
    if (status !== 'success' && status !== 'successful') {
      return { ok: false, reason: `Provider reports the charge as "${txn.status}"` };
    }
    const currency = (txn.currency || '').toUpperCase();
    if (!currency) return { ok: false, reason: 'Provider returned no currency' };

    return {
      ok: true,
      amount: fromMinorUnits(txn.amount, currency),
      currency,
      providerRef: txn.reference || input.reference,
      paidAt: txn.paidAt ? new Date(txn.paidAt) : new Date(),
      fee: null,
      degraded: false,
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, reference: input.reference, provider: input.provider },
      'provider verification call failed'
    );

    // The gateway is unreachable. Refusing outright would leave a customer who
    // has genuinely paid stuck, so a *signature-verified* payload is accepted
    // as a degraded fallback and flagged for reconciliation to re-check later.
    // This is only ever reached after signature verification has passed.
    const fb = input.fallback;
    if (fb?.amountMinor != null && fb.currency) {
      return {
        ok: true,
        amount: fromMinorUnits(fb.amountMinor, fb.currency),
        currency: fb.currency.toUpperCase(),
        providerRef: input.reference,
        paidAt: new Date(),
        fee: null,
        degraded: true,
      };
    }
    return { ok: false, reason: `Could not verify with provider: ${(err as Error).message}` };
  }
}
