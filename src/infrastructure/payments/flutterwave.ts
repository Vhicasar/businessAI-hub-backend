import { env } from '../../shared/config/env';
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
 * Flutterwave v3 REST client (https://developer.flutterwave.com/reference).
 *
 * Mirrors the Paystack client behind the same PaymentProvider contract. The
 * interface speaks the smallest currency unit (kobo/cents) like Paystack;
 * Flutterwave's API works in major units, so amounts are divided by 100 on the
 * way out. Subscriptions use Flutterwave **Payment Plans**: `ensurePlan()`
 * creates one and the checkout passes its id as `payment_plan`, so Flutterwave
 * enrolls the customer in a recurring subscription.
 *
 * Webhooks are verified by comparing the `verif-hash` header to the dashboard
 * "Secret hash" (FLUTTERWAVE_SECRET_HASH) — Flutterwave does not HMAC-sign.
 */

const FLW_BASE = 'https://api.flutterwave.com/v3';

/** Flutterwave payment-plan interval names. */
const INTERVAL_MAP: Record<'MONTHLY' | 'YEARLY', string> = {
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
};

interface FlwEnvelope<T> {
  status: string; // "success" | "error"
  message: string;
  data: T;
}

/** Smallest-unit (kobo/cents) → major units for the Flutterwave API. */
function toMajor(amount: number): number {
  return Math.round(amount) / 100;
}

export class FlutterwaveClient implements PaymentProvider {
  readonly name = 'flutterwave' as const;

  /** See PaystackClient: defaults to platform config; bind a resolver for per-org accounts. */
  constructor(private readonly resolveConfig: () => ResolvedPaymentConfig = getPaymentConfig) {}

  private get config() {
    return this.resolveConfig();
  }

  private get secretKey(): string {
    return this.config.secretKey;
  }

  get enabled(): boolean {
    return this.config.provider === 'flutterwave' && Boolean(this.secretKey);
  }

  get publicKey(): string {
    return this.config.publicKey;
  }

  private assertEnabled(): void {
    if (!this.secretKey) {
      throw new AppError(
        'FLUTTERWAVE_NOT_CONFIGURED',
        503,
        'Online payments are not configured. Set a Flutterwave secret key to enable checkout.'
      );
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    this.assertEnabled();
    const res = await fetch(`${FLW_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => null)) as FlwEnvelope<T> | null;
    if (!res.ok || body?.status !== 'success') {
      logger.error({ path, status: res.status, message: body?.message }, 'Flutterwave request failed');
      throw new AppError(
        'FLUTTERWAVE_ERROR',
        502,
        body?.message || `Flutterwave request failed (${res.status})`
      );
    }
    return body.data;
  }

  async initializeTransaction(input: InitializeTxnInput): Promise<InitializeTxnResult> {
    const data = await this.request<{ link: string }>('/payments', {
      method: 'POST',
      body: JSON.stringify({
        tx_ref: input.reference,
        amount: toMajor(input.amount),
        currency: input.currency ?? env.billing.currency,
        redirect_url: input.callbackUrl ?? this.config.callbackUrl,
        customer: { email: input.email },
        // Enrolls the customer in a recurring subscription when set.
        ...(input.planCode ? { payment_plan: input.planCode } : {}),
        meta: input.metadata ?? {},
      }),
    });
    return { authorizationUrl: data.link, reference: input.reference };
  }

  async verifyTransaction(reference: string): Promise<VerifyTxnResult> {
    const d = await this.request<{
      status: string; // "successful" | "failed" | "pending"
      tx_ref: string;
      amount: number; // major units
      currency: string;
      created_at: string | null;
      customer: { id?: number; email: string | null } | null;
      meta: Record<string, unknown> | null;
      plan?: number | null;
    }>(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`);
    return {
      // Normalize to the shared vocabulary the billing service checks against.
      status: d.status === 'successful' ? 'success' : d.status,
      reference: d.tx_ref,
      amount: Math.round(d.amount * 100),
      currency: d.currency,
      paidAt: d.created_at,
      // Flutterwave has no Paystack-style customer_code; use the email as the
      // opaque customer key so findSubscriptionCode can look the subscription up.
      customerCode: d.customer?.email ?? null,
      customerEmail: d.customer?.email ?? null,
      metadata: d.meta,
      planCode: d.plan != null ? String(d.plan) : null,
    };
  }

  async ensurePlan(input: EnsurePlanInput): Promise<EnsurePlanResult> {
    const data = await this.request<{ id: number }>('/payment-plans', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        amount: toMajor(input.amount),
        interval: INTERVAL_MAP[input.interval],
        currency: input.currency,
      }),
    });
    return { planCode: String(data.id) };
  }

  async findSubscriptionCode(customerEmail: string, planCode: string): Promise<string | null> {
    try {
      const subs = await this.request<Array<{ id: number; status: string; plan: number; customer: { email: string } }>>(
        `/subscriptions?email=${encodeURIComponent(customerEmail)}&plan=${encodeURIComponent(planCode)}`,
      );
      const match = subs.find((s) => s.status === 'active') ?? subs[0];
      return match ? String(match.id) : null;
    } catch (err) {
      logger.warn({ err, customerEmail, planCode }, 'Flutterwave findSubscriptionCode failed');
      return null;
    }
  }

  async disableSubscription(subscriptionCode: string): Promise<void> {
    try {
      await this.request(`/subscriptions/${encodeURIComponent(subscriptionCode)}/cancel`, { method: 'PUT' });
    } catch (err) {
      logger.warn({ err, subscriptionCode }, 'Flutterwave disableSubscription failed');
    }
  }

  /** Compares the `verif-hash` header to the configured Secret hash. */
  verifyWebhookSignature(_rawBody: Buffer | string, signature: string | undefined): boolean {
    const secret = this.config.webhookSecret;
    if (!secret || !signature) return false;
    return signature === secret;
  }

  parseWebhookEvent(body: unknown): NormalizedWebhookEvent {
    const e = (body ?? {}) as {
      event?: string;
      data?: {
        tx_ref?: string;
        status?: string;
        id?: number;
        plan?: number;
        customer?: { email?: string };
      };
    };
    const data = e.data ?? {};
    const base = {
      provider: this.name,
      reference: data.tx_ref,
      subscriptionCode: data.id != null ? String(data.id) : undefined,
      planCode: data.plan != null ? String(data.plan) : undefined,
      customerEmail: data.customer?.email,
    };
    switch (e.event) {
      case 'charge.completed':
        // Only successful charges advance billing.
        return { ...base, type: data.status === 'successful' ? 'charge_success' : 'other' };
      case 'subscription.cancelled':
        return { ...base, type: 'subscription_disable' };
      default:
        return { ...base, type: 'other' };
    }
  }
}

export const flutterwave = new FlutterwaveClient();
