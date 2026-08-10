import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from '../../shared/logger';
import { AppError } from '../../shared/errors';
import { getPaymentConfig, type ResolvedPaymentConfig } from './config';
import type {
  PaymentProvider,
  InitializeTxnInput,
  InitializeTxnResult,
  VerifyTxnResult,
  EnsurePlanInput,
  EnsurePlanResult,
  NormalizedWebhookEvent,
} from './types';

/**
 * Moniepoint client, via the Monnify API (https://developers.monnify.com).
 *
 * Moniepoint's collection gateway is Monnify, so that is what this talks to.
 * It differs from the other adapters in one significant way: **the credentials
 * are not the API token**. An API key and secret are exchanged for a bearer
 * token that expires after an hour, so every call needs a live token and the
 * exchange has to be cached — doing it per request would triple the latency of
 * every checkout and hammer the auth endpoint.
 *
 * It also needs a contract code alongside the key pair, which is what says
 * which Monnify contract to credit.
 */

const LIVE_BASE = 'https://api.monnify.com';
const SANDBOX_BASE = 'https://sandbox.monnify.com';

/** Refresh a minute early — a token that expires mid-flight fails a payment. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

interface MonnifyEnvelope<T> {
  requestSuccessful: boolean;
  responseMessage: string;
  responseCode: string;
  responseBody: T;
}

interface MonnifyInitBody {
  transactionReference: string;
  paymentReference: string;
  checkoutUrl: string;
  enabledPaymentMethod?: string[];
}

interface MonnifyTxnBody {
  paymentStatus: string;
  amountPaid: number | string;
  totalPayable: number | string;
  currencyCode?: string;
  paidOn?: string;
  transactionReference: string;
  paymentReference: string;
  customer?: { email?: string; name?: string };
  paymentMethod?: string;
}

export class MoniepointClient implements PaymentProvider {
  readonly name = 'moniepoint' as const;

  /** Cached bearer token, shared across calls for this client instance. */
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: () => ResolvedPaymentConfig = getPaymentConfig) {}

  private conf(): ResolvedPaymentConfig {
    return this.cfg();
  }

  /**
   * All three are required: the key pair authenticates, and the contract code
   * says which contract the money lands in. Without the contract code Monnify
   * rejects every initialisation, so it is better to be plainly unusable.
   */
  get enabled(): boolean {
    const c = this.conf();
    return Boolean(c.secretKey && c.publicKey && c.merchantId);
  }

  get publicKey(): string {
    return this.conf().publicKey;
  }

  /** Monnify test API keys are prefixed MK_TEST. */
  private base(): string {
    return /_TEST_/i.test(this.conf().publicKey) ? SANDBOX_BASE : LIVE_BASE;
  }

  /**
   * Exchange the API key and secret for a bearer token, reusing it until it is
   * nearly expired.
   */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;

    const c = this.conf();
    const basic = Buffer.from(`${c.publicKey}:${c.secretKey}`).toString('base64');
    const res = await fetch(`${this.base()}/api/v1/auth/login`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
    });
    const json = (await res.json().catch(() => null)) as MonnifyEnvelope<{
      accessToken: string;
      expiresIn: number;
    }> | null;

    if (!res.ok || !json?.requestSuccessful || !json.responseBody?.accessToken) {
      const message = json?.responseMessage || `Monnify authentication failed (${res.status})`;
      logger.warn({ message, code: json?.responseCode }, 'Moniepoint auth error');
      throw new AppError('MONIEPOINT_AUTH_FAILED', 502, message);
    }

    const ttlMs = (json.responseBody.expiresIn ?? 3600) * 1000;
    this.token = {
      value: json.responseBody.accessToken,
      expiresAt: Date.now() + Math.max(0, ttlMs - TOKEN_SAFETY_MARGIN_MS),
    };
    return this.token.value;
  }

  private async call<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; retryOnAuthFailure?: boolean }
  ): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(`${this.base()}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    // A token can be revoked before it expires. One retry with a fresh token
    // turns that into a hiccup rather than a failed payment.
    if (res.status === 401 && init.retryOnAuthFailure !== false) {
      this.token = null;
      return this.call<T>(path, { ...init, retryOnAuthFailure: false });
    }

    const json = (await res.json().catch(() => null)) as MonnifyEnvelope<T> | null;
    if (!res.ok || !json?.requestSuccessful) {
      const message = json?.responseMessage || `Monnify request failed (${res.status})`;
      logger.warn({ path, code: json?.responseCode, message }, 'Moniepoint API error');
      throw new AppError('MONIEPOINT_ERROR', 502, message);
    }
    return json.responseBody;
  }

  async initializeTransaction(input: InitializeTxnInput): Promise<InitializeTxnResult> {
    const currency = (input.currency || 'NGN').toUpperCase();
    // Monnify quotes in major units, unlike most gateways — the caller contract
    // is minor units, so this is the one place the conversion happens.
    const amount = input.amount / 100;

    const body = await this.call<MonnifyInitBody>('/api/v1/merchant/transactions/init-transaction', {
      method: 'POST',
      body: {
        amount,
        customerName: input.email.split('@')[0] || 'Customer',
        customerEmail: input.email,
        paymentReference: input.reference,
        paymentDescription: 'Payment',
        currencyCode: currency,
        contractCode: this.conf().merchantId,
        redirectUrl: input.callbackUrl ?? this.conf().callbackUrl,
        metadata: input.metadata ?? {},
      },
    });

    // The docs are explicit that the echoed values must be checked: a reply
    // describing a different reference is not a checkout for our payment.
    if (body.paymentReference && body.paymentReference !== input.reference) {
      throw new AppError(
        'MONIEPOINT_REFERENCE_MISMATCH',
        502,
        'Monnify returned a checkout for a different payment reference.'
      );
    }

    return {
      authorizationUrl: body.checkoutUrl,
      reference: input.reference,
      accessCode: body.transactionReference,
    };
  }

  async verifyTransaction(reference: string): Promise<VerifyTxnResult> {
    const body = await this.call<MonnifyTxnBody>(
      `/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(reference)}`,
      { method: 'GET' }
    );

    const status = String(body.paymentStatus ?? '').toUpperCase();
    const currency = (body.currencyCode || 'NGN').toUpperCase();
    // `amountPaid` is what actually arrived, which is the figure that matters
    // for a part payment; `totalPayable` is what was asked for.
    const paid = Number(body.amountPaid ?? 0);

    return {
      status: status === 'PAID' ? 'success' : status.toLowerCase(),
      reference: body.paymentReference || reference,
      // Back to minor units for the caller contract.
      amount: Math.round(paid * 100),
      currency,
      paidAt: body.paidOn ? new Date(body.paidOn).toISOString() : status === 'PAID' ? new Date().toISOString() : null,
      customerCode: body.transactionReference ?? null,
      customerEmail: body.customer?.email ?? null,
      metadata: null,
    };
  }

  /**
   * Monnify signs its webhooks with HMAC-SHA512 over the raw request body,
   * keyed by the client secret, in the `monnify-signature` header.
   *
   * The raw bytes matter: re-serialising the parsed body can reorder keys or
   * change number formatting, and the hash would no longer match a legitimate
   * delivery.
   */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    const c = this.conf();
    if (!signature || !c.secretKey) return false;

    const raw = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = createHmac('sha512', c.secretKey).update(raw).digest('hex');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    // Constant time: an early exit on the first wrong byte tells an attacker
    // how much of a guessed signature was right.
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhookEvent(body: unknown): NormalizedWebhookEvent {
    const b = (body ?? {}) as Record<string, unknown>;
    const eventType = String(b.eventType ?? '').toUpperCase();
    const data = ((b.eventData as Record<string, unknown>) ?? b) as Record<string, unknown>;
    const status = String(data.paymentStatus ?? '').toUpperCase();

    return {
      provider: 'moniepoint',
      type: eventType === 'SUCCESSFUL_TRANSACTION' || status === 'PAID' ? 'charge_success' : 'other',
      reference:
        typeof data.paymentReference === 'string' ? data.paymentReference : undefined,
      customerEmail:
        typeof (data.customer as Record<string, unknown>)?.email === 'string'
          ? ((data.customer as Record<string, unknown>).email as string)
          : undefined,
    };
  }

  /**
   * Monnify does have recurring products, but not one this platform drives
   * through `ensurePlan`. Failing loudly beats issuing a plan code that never
   * charges — a subscription that silently stops billing is worse than one
   * that was never set up.
   */
  async ensurePlan(_input: EnsurePlanInput): Promise<EnsurePlanResult> {
    throw new AppError(
      'PROVIDER_NO_SUBSCRIPTIONS',
      501,
      'Moniepoint is not set up for recurring subscriptions here. Use it for one-off collections, or connect a provider that does.'
    );
  }

  async findSubscriptionCode(): Promise<string | null> {
    return null;
  }

  async disableSubscription(): Promise<void> {
    /* nothing to disable — no subscriptions are ever created */
  }
}

export const moniepoint = new MoniepointClient();
