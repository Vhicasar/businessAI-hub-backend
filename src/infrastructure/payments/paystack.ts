import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { AppError } from '../../shared/errors';
import { getPaymentConfig, type ResolvedPaymentConfig } from './config';
import type {
  BankOption,
  CreateRecipientInput,
  CreateRecipientResult,
  PayoutCapableProvider,
  TransferInput,
  TransferResult,
  TransferState,
  PaymentProvider,
  InitializeTxnInput,
  InitializeTxnResult,
  VerifyTxnResult,
  EnsurePlanInput,
  EnsurePlanResult,
  NormalizedWebhookEvent,
} from './types';

/**
 * Paystack REST client (https://paystack.com/docs/api).
 *
 * Subscriptions use real Paystack **Plans + Subscriptions**: `ensurePlan()`
 * creates/reuses a Plan and the checkout passes its `plan` code, so Paystack
 * creates a recurring Subscription (visible in the dashboard, auto-charged each
 * period) instead of a one-off transaction. One-off flows (SMS wallet, add-ons)
 * omit the plan and charge once. Keys resolve from the admin-synced config,
 * falling back to local env. Degrades gracefully: no secret key ⇒ `enabled`
 * false and callers fall back to manual activation.
 */

const PAYSTACK_BASE = 'https://api.paystack.co';

/** Paystack plan interval names. */
const INTERVAL_MAP: Record<'MONTHLY' | 'YEARLY', string> = {
  MONTHLY: 'monthly',
  YEARLY: 'annually',
};

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

/** Paystack transfer status → our normalized state. */
function mapTransferStatus(status: string): TransferState {
  const s = (status || '').toLowerCase();
  if (s === 'success') return 'PAID';
  if (s === 'failed' || s === 'abandoned') return 'FAILED';
  if (s === 'reversed') return 'REVERSED';
  return 'PENDING'; // pending | otp | received | processing
}

export class PaystackClient implements PaymentProvider, PayoutCapableProvider {
  readonly name = 'paystack' as const;

  /**
   * By default the client reads the *platform* config (admin-synced billing
   * keys). Pass a resolver to bind it to a specific merchant account — used for
   * per-organization customer collections (payment links).
   */
  constructor(private readonly resolveConfig: () => ResolvedPaymentConfig = getPaymentConfig) {}

  private get config() {
    return this.resolveConfig();
  }

  private get secretKey(): string {
    return this.config.secretKey;
  }

  get enabled(): boolean {
    return this.config.provider === 'paystack' && Boolean(this.secretKey);
  }

  get publicKey(): string {
    return this.config.publicKey;
  }

  private assertEnabled(): void {
    if (!this.secretKey) {
      throw new AppError(
        'PAYSTACK_NOT_CONFIGURED',
        503,
        'Online payments are not configured. Set a Paystack secret key to enable checkout.'
      );
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    this.assertEnabled();
    const res = await fetch(`${PAYSTACK_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => null)) as PaystackEnvelope<T> | null;
    if (!res.ok || !body?.status) {
      logger.error({ path, status: res.status, message: body?.message }, 'Paystack request failed');
      throw new AppError(
        'PAYSTACK_ERROR',
        502,
        body?.message || `Paystack request failed (${res.status})`
      );
    }
    return body.data;
  }

  async initializeTransaction(input: InitializeTxnInput): Promise<InitializeTxnResult> {
    const data = await this.request<{ authorization_url: string; access_code: string; reference: string }>(
      '/transaction/initialize',
      {
        method: 'POST',
        body: JSON.stringify({
          email: input.email,
          amount: input.amount,
          reference: input.reference,
          currency: input.currency ?? env.billing.currency,
          callback_url: input.callbackUrl ?? this.config.callbackUrl,
          // When a plan code is supplied Paystack creates a recurring
          // Subscription on first charge and ignores `amount`.
          ...(input.planCode ? { plan: input.planCode } : {}),
          metadata: input.metadata ?? {},
        }),
      }
    );
    return {
      authorizationUrl: data.authorization_url,
      accessCode: data.access_code,
      reference: data.reference,
    };
  }

  async verifyTransaction(reference: string): Promise<VerifyTxnResult> {
    const d = await this.request<{
      status: string;
      reference: string;
      amount: number;
      currency: string;
      paid_at: string | null;
      customer: { customer_code: string | null; email: string | null } | null;
      plan: string | null;
      plan_object?: { plan_code?: string } | null;
      metadata: Record<string, unknown> | null;
    }>(`/transaction/verify/${encodeURIComponent(reference)}`);
    return {
      status: d.status,
      reference: d.reference,
      amount: d.amount,
      currency: d.currency,
      paidAt: d.paid_at,
      customerCode: d.customer?.customer_code ?? null,
      customerEmail: d.customer?.email ?? null,
      metadata: d.metadata,
      planCode: d.plan_object?.plan_code ?? (typeof d.plan === 'string' ? d.plan : null),
    };
  }

  async ensurePlan(input: EnsurePlanInput): Promise<EnsurePlanResult> {
    const data = await this.request<{ plan_code: string }>('/plan', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        amount: input.amount,
        interval: INTERVAL_MAP[input.interval],
        currency: input.currency,
      }),
    });
    return { planCode: data.plan_code };
  }

  async findSubscriptionCode(customerCode: string, planCode: string): Promise<string | null> {
    try {
      const subs = await this.request<Array<{ subscription_code: string; status: string; plan: { plan_code: string } }>>(
        `/subscription?customer=${encodeURIComponent(customerCode)}`,
      );
      const match = subs.find((s) => s.plan?.plan_code === planCode && s.status === 'active') ?? subs[0];
      return match?.subscription_code ?? null;
    } catch (err) {
      logger.warn({ err, customerCode, planCode }, 'Paystack findSubscriptionCode failed');
      return null;
    }
  }

  async disableSubscription(subscriptionCode: string): Promise<void> {
    // Disabling needs the subscription's email_token; fetch it first.
    try {
      const sub = await this.request<{ email_token: string }>(
        `/subscription/${encodeURIComponent(subscriptionCode)}`,
      );
      await this.request('/subscription/disable', {
        method: 'POST',
        body: JSON.stringify({ code: subscriptionCode, token: sub.email_token }),
      });
    } catch (err) {
      logger.warn({ err, subscriptionCode }, 'Paystack disableSubscription failed');
    }
  }

  /** Verifies the `x-paystack-signature` header (HMAC-SHA512 of the raw body). */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    if (!signature || !this.secretKey) return false;
    const expected = createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }


  // ---- Payouts (Transfers API) ----

  async listBanks(country = 'nigeria'): Promise<BankOption[]> {
    const data = await this.request<Array<{ name: string; code: string }>>(
      `/bank?country=${encodeURIComponent(country.toLowerCase())}&perPage=100`
    );
    return data.map((b) => ({ name: b.name, code: b.code }));
  }

  async resolveAccount(accountNumber: string, bankCode: string): Promise<{ accountName: string } | null> {
    try {
      const data = await this.request<{ account_name: string }>(
        `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`
      );
      return data?.account_name ? { accountName: data.account_name } : null;
    } catch {
      // A rejected lookup means "we can't confirm this account", not an outage.
      return null;
    }
  }

  async createRecipient(input: CreateRecipientInput): Promise<CreateRecipientResult> {
    const data = await this.request<{ recipient_code: string; details?: { account_name?: string } }>(
      '/transferrecipient',
      {
        method: 'POST',
        body: JSON.stringify({
          type: input.type === 'MOBILE_MONEY' ? 'mobile_money' : 'nuban',
          name: input.accountName,
          account_number: input.accountNumber,
          bank_code: input.bankCode,
          currency: input.currency.toUpperCase(),
        }),
      }
    );
    return { recipientRef: data.recipient_code, resolvedName: data.details?.account_name ?? null };
  }

  async initiateTransfer(input: TransferInput): Promise<TransferResult> {
    const data = await this.request<{ transfer_code: string; status: string; reference?: string }>('/transfer', {
      method: 'POST',
      body: JSON.stringify({
        source: 'balance',
        amount: input.amount,
        recipient: input.recipientRef,
        reference: input.reference,
        reason: input.reason ?? 'Vhicasar Pay payout',
        currency: input.currency.toUpperCase(),
      }),
    });
    return { providerRef: data.transfer_code, status: mapTransferStatus(data.status) };
  }

  async verifyTransfer(reference: string): Promise<TransferResult> {
    const data = await this.request<{ transfer_code: string; status: string }>(
      `/transfer/verify/${encodeURIComponent(reference)}`
    );
    return { providerRef: data.transfer_code, status: mapTransferStatus(data.status) };
  }

  parseWebhookEvent(body: unknown): NormalizedWebhookEvent {
    const e = (body ?? {}) as {
      event?: string;
      data?: {
        reference?: string;
        subscription_code?: string;
        plan?: { plan_code?: string } | string;
        customer?: { email?: string };
      };
    };
    const data = e.data ?? {};
    const planCode = typeof data.plan === 'object' ? data.plan?.plan_code : undefined;
    const base = {
      provider: this.name,
      reference: data.reference,
      subscriptionCode: data.subscription_code,
      planCode,
      customerEmail: data.customer?.email,
    };
    switch (e.event) {
      case 'charge.success':
        return { ...base, type: 'charge_success' };
      case 'subscription.create':
        return { ...base, type: 'subscription_create' };
      case 'subscription.disable':
      case 'subscription.not_renew':
        return { ...base, type: 'subscription_disable' };
      default:
        return { ...base, type: 'other' };
    }
  }
}

export const paystack = new PaystackClient();
