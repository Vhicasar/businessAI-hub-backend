import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { AppError } from '../../shared/errors';

/**
 * Thin Paystack REST client (https://paystack.com/docs/api).
 *
 * Uses transaction *initialize + verify* plus signed webhooks — no pre-created
 * Paystack Plans required, so a subscription is activated for one period each
 * time a charge succeeds. Degrades gracefully: when no secret key is set,
 * `enabled` is false and callers fall back to manual activation.
 */

const PAYSTACK_BASE = 'https://api.paystack.co';

export interface InitializeTxnInput {
  email: string;
  /** Amount in the smallest currency unit (kobo for NGN). */
  amount: number;
  reference: string;
  currency?: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface InitializeTxnResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface VerifyTxnResult {
  status: string; // "success" | "failed" | ...
  reference: string;
  amount: number; // kobo
  currency: string;
  paidAt: string | null;
  customerCode: string | null;
  customerEmail: string | null;
  metadata: Record<string, unknown> | null;
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

class PaystackClient {
  get enabled(): boolean {
    return env.billing.paystackEnabled;
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new AppError(
        'PAYSTACK_NOT_CONFIGURED',
        503,
        'Online payments are not configured. Set PAYSTACK_SECRET_KEY to enable checkout.'
      );
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    this.assertEnabled();
    const res = await fetch(`${PAYSTACK_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.billing.paystackSecretKey}`,
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
          callback_url: input.callbackUrl ?? env.billing.callbackUrl,
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
    };
  }

  /** Verifies the `x-paystack-signature` header (HMAC-SHA512 of the raw body). */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    if (!signature || !env.billing.paystackSecretKey) return false;
    const expected = createHmac('sha512', env.billing.paystackSecretKey)
      .update(rawBody)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export const paystack = new PaystackClient();
