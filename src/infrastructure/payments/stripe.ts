import { createHmac, timingSafeEqual } from 'crypto';
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
 * Stripe REST client (https://stripe.com/docs/api) behind the shared
 * PaymentProvider contract. No SDK — raw form-encoded calls like the Paystack /
 * Flutterwave clients. Checkout uses hosted Checkout Sessions; our own
 * `reference` is stored as `metadata.ref` (and client_reference_id) so verify
 * can find the charge via the Search API without local state. Amounts are in the
 * smallest unit (cents) — matching the interface. Subscriptions use Stripe
 * Prices (`ensurePlan`) + a subscription-mode Checkout Session.
 */

const STRIPE_BASE = 'https://api.stripe.com/v1';
const INTERVAL_MAP: Record<'MONTHLY' | 'YEARLY', string> = { MONTHLY: 'month', YEARLY: 'year' };

/** Flatten a nested object into Stripe's `a[b][c]=v` form-encoding. */
function toForm(obj: Record<string, unknown>, prefix = ''): string[] {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === 'object') parts.push(...toForm(item as Record<string, unknown>, `${key}[${i}]`));
        else parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (v && typeof v === 'object') {
      parts.push(...toForm(v as Record<string, unknown>, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts;
}

/** Stripe metadata values must be strings. */
function stringifyMeta(meta?: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

export class StripeClient implements PaymentProvider {
  readonly name = 'stripe' as const;

  constructor(private readonly resolveConfig: () => ResolvedPaymentConfig = getPaymentConfig) {}

  private get config() { return this.resolveConfig(); }
  private get secretKey(): string { return this.config.secretKey; }
  get enabled(): boolean { return this.config.provider === 'stripe' && Boolean(this.secretKey); }
  get publicKey(): string { return this.config.publicKey; }

  private assertEnabled(): void {
    if (!this.secretKey) {
      throw new AppError('STRIPE_NOT_CONFIGURED', 503, 'Online payments are not configured. Set a Stripe secret key to enable checkout.');
    }
  }

  private async request<T>(path: string, form?: Record<string, unknown>, method: 'POST' | 'GET' | 'DELETE' = 'POST'): Promise<T> {
    this.assertEnabled();
    const isGet = method === 'GET';
    const query = isGet && form ? `?${toForm(form).join('&')}` : '';
    const res = await fetch(`${STRIPE_BASE}${path}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        ...(isGet ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      },
      body: isGet || !form ? undefined : toForm(form).join('&'),
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    if (!res.ok || body?.error) {
      logger.error({ path, status: res.status, message: body?.error?.message }, 'Stripe request failed');
      throw new AppError('STRIPE_ERROR', 502, body?.error?.message || `Stripe request failed (${res.status})`);
    }
    return body as T;
  }

  async initializeTransaction(input: InitializeTxnInput): Promise<InitializeTxnResult> {
    const currency = (input.currency ?? env.billing.currency).toLowerCase();
    const callback = input.callbackUrl ?? this.config.callbackUrl;
    const sep = callback.includes('?') ? '&' : '?';
    const successUrl = `${callback}${sep}reference=${encodeURIComponent(input.reference)}`;
    const meta = { ref: input.reference, ...stringifyMeta(input.metadata) };

    const form: Record<string, unknown> = {
      mode: input.planCode ? 'subscription' : 'payment',
      success_url: successUrl,
      cancel_url: callback,
      client_reference_id: input.reference,
      customer_email: input.email,
      metadata: meta,
      'line_items[0][quantity]': 1,
    };
    if (input.planCode) {
      (form as Record<string, unknown>)['line_items[0][price]'] = input.planCode;
      form.subscription_data = { metadata: meta };
    } else {
      form['line_items[0][price_data][currency]'] = currency;
      form['line_items[0][price_data][product_data][name]'] = (input.metadata?.title as string) || 'Payment';
      form['line_items[0][price_data][unit_amount]'] = Math.round(input.amount);
      form.payment_intent_data = { metadata: meta };
    }

    const session = await this.request<{ id: string; url: string }>('/checkout/sessions', form);
    return { authorizationUrl: session.url, reference: input.reference, accessCode: session.id };
  }

  async verifyTransaction(reference: string): Promise<VerifyTxnResult> {
    // One-off: the PaymentIntent carries our ref. Search for it.
    const pis = await this.request<{ data: Array<{ status: string; amount: number; currency: string; customer: string | null; receipt_email: string | null; metadata: Record<string, string> }> }>(
      '/payment_intents/search',
      { query: `metadata['ref']:'${reference}'` },
      'GET',
    ).catch(() => ({ data: [] }));
    const pi = pis.data[0];
    if (pi) {
      return {
        status: pi.status === 'succeeded' ? 'success' : pi.status,
        reference,
        amount: pi.amount,
        currency: pi.currency.toUpperCase(),
        paidAt: pi.status === 'succeeded' ? new Date().toISOString() : null,
        customerCode: pi.customer,
        customerEmail: pi.receipt_email,
        metadata: pi.metadata,
      };
    }

    // Subscription: find the subscription by our ref, read its latest invoice.
    const subs = await this.request<{ data: Array<{ id: string; status: string; customer: string; latest_invoice: string }> }>(
      '/subscriptions/search',
      { query: `metadata['ref']:'${reference}'` },
      'GET',
    ).catch(() => ({ data: [] }));
    const sub = subs.data[0];
    if (sub) {
      const inv = await this.request<{ amount_paid: number; currency: string; customer_email: string | null }>(`/invoices/${sub.latest_invoice}`, undefined, 'GET').catch(() => null);
      const active = sub.status === 'active' || sub.status === 'trialing';
      return {
        status: active ? 'success' : sub.status,
        reference,
        amount: inv?.amount_paid ?? 0,
        currency: (inv?.currency ?? env.billing.currency).toUpperCase(),
        paidAt: active ? new Date().toISOString() : null,
        customerCode: sub.customer,
        customerEmail: inv?.customer_email ?? null,
        metadata: { ref: reference },
        subscriptionCode: sub.id,
      };
    }

    return { status: 'failed', reference, amount: 0, currency: env.billing.currency, paidAt: null, customerCode: null, customerEmail: null, metadata: null };
  }

  async ensurePlan(input: EnsurePlanInput): Promise<EnsurePlanResult> {
    const price = await this.request<{ id: string }>('/prices', {
      unit_amount: Math.round(input.amount),
      currency: input.currency.toLowerCase(),
      recurring: { interval: INTERVAL_MAP[input.interval] },
      product_data: { name: input.name },
    });
    return { planCode: price.id };
  }

  async findSubscriptionCode(customerCode: string): Promise<string | null> {
    try {
      const subs = await this.request<{ data: Array<{ id: string; status: string }> }>(
        '/subscriptions', { customer: customerCode, status: 'active', limit: 1 }, 'GET',
      );
      return subs.data[0]?.id ?? null;
    } catch (err) {
      logger.warn({ err, customerCode }, 'Stripe findSubscriptionCode failed');
      return null;
    }
  }

  async disableSubscription(subscriptionCode: string): Promise<void> {
    try {
      // Stop auto-renew but keep access until the period ends (mirrors billing).
      await this.request(`/subscriptions/${encodeURIComponent(subscriptionCode)}`, { cancel_at_period_end: true });
    } catch (err) {
      logger.warn({ err, subscriptionCode }, 'Stripe disableSubscription failed');
    }
  }

  /** Verifies the `stripe-signature` header (t=…,v1=HMAC-SHA256 of `t.payload`). */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    const secret = this.config.webhookSecret;
    if (!secret || !signature) return false;
    const parts = Object.fromEntries(signature.split(',').map((p) => p.split('=') as [string, string]));
    const t = parts.t;
    const v1 = parts.v1;
    if (!t || !v1) return false;
    const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(v1);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhookEvent(body: unknown): NormalizedWebhookEvent {
    const e = (body ?? {}) as { type?: string; data?: { object?: Record<string, unknown> } };
    const o = (e.data?.object ?? {}) as Record<string, unknown>;
    const base = {
      provider: this.name,
      reference: (o.client_reference_id as string) || ((o.metadata as Record<string, string>)?.ref),
      subscriptionCode: (o.subscription as string) || (e.type?.startsWith('customer.subscription') ? (o.id as string) : undefined),
      customerEmail: ((o.customer_details as { email?: string })?.email) || (o.customer_email as string) || undefined,
    };
    switch (e.type) {
      case 'checkout.session.completed':
        return { ...base, type: o.payment_status === 'paid' || o.status === 'complete' ? 'charge_success' : 'other' };
      case 'invoice.paid':
        // Recurring renewal — route by subscription.
        return { provider: this.name, type: 'charge_success', reference: o.id as string, subscriptionCode: o.subscription as string };
      case 'customer.subscription.deleted':
        return { ...base, type: 'subscription_disable' };
      default:
        return { ...base, type: 'other' };
    }
  }
}

export const stripe = new StripeClient();
