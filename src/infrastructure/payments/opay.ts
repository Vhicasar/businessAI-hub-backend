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
 * OPay Cashier client (https://documentation.opaycheckout.com).
 *
 * Two things about OPay differ from the other gateways and are the source of
 * most integration mistakes, so they are handled explicitly here:
 *
 *  1. **Two credentials, two purposes.** Creating a checkout authenticates with
 *     the *public* key as a bearer token; querying status authenticates with an
 *     HMAC-SHA512 *signature* over the request payload, keyed by the private
 *     key. Using the wrong one for either call fails with an opaque error.
 *  2. **The payload must be sorted.** OPay signs the JSON with its keys in
 *     alphabetical order, so the body we send and the body we sign have to be
 *     serialised the same deterministic way — an ordinary JSON.stringify of an
 *     object literal will not match.
 *
 * OPay has no subscription primitive we use, so `ensurePlan` reports that
 * plainly rather than pretending recurring billing is set up.
 */

const LIVE_BASE = 'https://liveapi.opaycheckout.com';
const SANDBOX_BASE = 'https://testapi.opaycheckout.com';

/** OPay's terminal states, from the Cashier status API. */
type OpayStatus = 'INITIAL' | 'PENDING' | 'SUCCESS' | 'FAIL' | 'CLOSE';

interface OpayEnvelope<T> {
  code: string;
  message: string;
  data: T;
}

interface OpayAmount {
  total: number;
  currency: string;
}

interface OpayStatusData {
  reference: string;
  orderNo: string;
  status: OpayStatus;
  amount: OpayAmount;
  createTime?: string | number;
  failureReason?: string;
}

/**
 * Currencies with no minor unit. OPay quotes amounts in cents, so dividing a
 * zero-decimal currency by 100 would under-report by 99%.
 */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'XAF', 'XOF', 'UGX', 'RWF']);

function toMinor(amount: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? Math.round(amount) : Math.round(amount * 100);
}

function fromMinor(amountMinor: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? amountMinor : amountMinor / 100;
}

/**
 * Serialise with keys in alphabetical order, recursively.
 *
 * This is what OPay signs. It has to be applied to the body we actually send
 * as well, or the signature describes a different document than the one that
 * arrives and the request is rejected.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export class OpayClient implements PaymentProvider {
  readonly name = 'opay' as const;

  constructor(private readonly cfg: () => ResolvedPaymentConfig = getPaymentConfig) {}

  private conf(): ResolvedPaymentConfig {
    return this.cfg();
  }

  /**
   * OPay needs all three: the public key opens a checkout, the private key
   * signs status queries, and the merchant id says whose account to credit.
   * Missing any one of them means we cannot transact, so the provider reports
   * itself unusable rather than failing later mid-payment.
   */
  get enabled(): boolean {
    const c = this.conf();
    return Boolean(c.secretKey && c.publicKey && c.merchantId);
  }

  get publicKey(): string {
    return this.conf().publicKey;
  }

  /** Live keys are prefixed OPAYPRV/OPAYPUB; test keys carry a TEST marker. */
  private base(): string {
    const c = this.conf();
    const isTest = /test/i.test(c.secretKey) || /test/i.test(c.publicKey);
    return isTest ? SANDBOX_BASE : LIVE_BASE;
  }

  private signature(payload: string): string {
    return createHmac('sha512', this.conf().secretKey).update(payload).digest('hex');
  }

  private async post<T>(
    path: string,
    payload: Record<string, unknown>,
    auth: 'public' | 'signature'
  ): Promise<T> {
    const c = this.conf();
    // Sign and send the *same* bytes — see canonicalJson.
    const body = canonicalJson(payload);
    const bearer = auth === 'public' ? c.publicKey : this.signature(body);

    const res = await fetch(`${this.base()}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        MerchantId: c.merchantId,
        'Content-Type': 'application/json',
      },
      body,
    });

    const json = (await res.json().catch(() => null)) as OpayEnvelope<T> | null;
    // OPay answers 200 with a non-zero code for business failures, so the HTTP
    // status alone is not the success signal.
    if (!res.ok || !json || json.code !== '00000') {
      const message = json?.message || `OPay request failed (${res.status})`;
      logger.warn({ path, code: json?.code, message }, 'OPay API error');
      throw new AppError('OPAY_ERROR', 502, message);
    }
    return json.data;
  }

  async initializeTransaction(input: InitializeTxnInput): Promise<InitializeTxnResult> {
    const currency = (input.currency || 'NGN').toUpperCase();
    const data = await this.post<{ cashierUrl: string; orderNo: string; reference: string }>(
      '/api/v1/international/cashier/create',
      {
        amount: {
          // `amount` arrives already in minor units from the caller contract,
          // so it is passed through rather than converted twice.
          currency,
          total: Math.round(input.amount),
        },
        country: 'NG',
        payMethod: 'BankCard',
        productList: [
          {
            productId: input.reference,
            name: 'Payment',
            description: 'Payment',
            price: Math.round(input.amount),
            quantity: 1,
          },
        ],
        reference: input.reference,
        returnUrl: input.callbackUrl ?? this.conf().callbackUrl,
        callbackUrl: input.callbackUrl ?? this.conf().callbackUrl,
        userInfo: { userEmail: input.email, userId: input.email },
        expireAt: 30,
      },
      'public'
    );

    return {
      authorizationUrl: data.cashierUrl,
      reference: data.reference || input.reference,
      accessCode: data.orderNo,
    };
  }

  async verifyTransaction(reference: string): Promise<VerifyTxnResult> {
    const data = await this.post<OpayStatusData>(
      '/api/v1/international/cashier/status',
      { country: 'NG', reference },
      'signature'
    );

    const currency = (data.amount?.currency || 'NGN').toUpperCase();
    return {
      // Normalised to the vocabulary the rest of the platform verifies against.
      status: data.status === 'SUCCESS' ? 'success' : data.status.toLowerCase(),
      reference: data.reference || reference,
      // The contract is minor units; OPay already reports cents.
      amount: Math.round(data.amount?.total ?? 0),
      currency,
      paidAt:
        data.status === 'SUCCESS'
          ? new Date(
              typeof data.createTime === 'number' ? data.createTime : Date.parse(String(data.createTime))
            ).toISOString()
          : null,
      customerCode: data.orderNo ?? null,
      customerEmail: null,
      metadata: null,
    };
  }

  /**
   * OPay signs its callbacks with HMAC-SHA512 over the payload, keyed by the
   * private key, and sends it in the body rather than a header.
   *
   * Compared in constant time: a byte-by-byte early exit leaks how much of a
   * forged signature was correct, which is enough to reconstruct one.
   */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    const c = this.conf();
    if (!c.secretKey) return false;

    const raw = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    let provided = signature;
    let signedPart = raw;

    // The callback carries { payload, sha512 }; fall back to the header form
    // for merchants configured to send it that way.
    try {
      const parsed = JSON.parse(raw) as { payload?: unknown; sha512?: string };
      if (parsed?.sha512) {
        provided = parsed.sha512;
        signedPart = canonicalJson(parsed.payload ?? {});
      }
    } catch {
      /* not JSON — treat the body as the signed material */
    }
    if (!provided) return false;

    const expected = createHmac('sha512', c.secretKey).update(signedPart).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhookEvent(body: unknown): NormalizedWebhookEvent {
    const b = (body ?? {}) as Record<string, unknown>;
    const payload = ((b.payload as Record<string, unknown>) ?? b) as Record<string, unknown>;
    const status = String(payload.status ?? '').toUpperCase();
    return {
      provider: 'opay',
      type: status === 'SUCCESS' ? 'charge_success' : 'other',
      reference: typeof payload.reference === 'string' ? payload.reference : undefined,
    };
  }

  /**
   * OPay has no plan/subscription primitive in the Cashier API we use, so
   * recurring billing is not available through it. Saying so is better than
   * returning a fake plan code that would silently never charge again.
   */
  async ensurePlan(_input: EnsurePlanInput): Promise<EnsurePlanResult> {
    throw new AppError(
      'PROVIDER_NO_SUBSCRIPTIONS',
      501,
      'OPay does not support recurring subscriptions here. Use it for one-off collections, or connect a provider that does.'
    );
  }

  async findSubscriptionCode(): Promise<string | null> {
    return null;
  }

  async disableSubscription(): Promise<void> {
    /* nothing to disable — no subscriptions are ever created */
  }
}

export const opay = new OpayClient();
