/**
 * Provider-agnostic payment contract. Both the Paystack and Flutterwave clients
 * implement this so the billing, SMS-wallet and add-on flows never depend on a
 * specific gateway — the *active* provider (chosen by the admin) is resolved at
 * call time via `getActivePaymentProvider()`.
 */

export type PaymentProviderName = 'paystack' | 'flutterwave' | 'stripe';

export interface InitializeTxnInput {
  email: string;
  /** Amount in the smallest currency unit (kobo/cents/pesewas). */
  amount: number;
  reference: string;
  currency?: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
  /**
   * Provider plan/subscription code. When set, the charge creates a *recurring
   * subscription* (visible in the gateway dashboard) instead of a one-off
   * payment. Obtain it from `ensurePlan()`.
   */
  planCode?: string;
}

export interface InitializeTxnResult {
  authorizationUrl: string;
  reference: string;
  accessCode?: string;
}

export interface VerifyTxnResult {
  status: string; // "success" | "failed" | ...
  reference: string;
  amount: number; // smallest unit
  currency: string;
  paidAt: string | null;
  customerCode: string | null;
  customerEmail: string | null;
  metadata: Record<string, unknown> | null;
  /** Set when the charge belongs to a recurring subscription. */
  subscriptionCode?: string | null;
  planCode?: string | null;
}

export interface EnsurePlanInput {
  /** Stable, human-readable plan name shown in the gateway dashboard. */
  name: string;
  /** Recurring amount in the smallest currency unit. */
  amount: number;
  currency: string;
  interval: 'MONTHLY' | 'YEARLY';
}

export interface EnsurePlanResult {
  planCode: string;
}

/** Normalized webhook event the billing service can act on regardless of gateway. */
export interface NormalizedWebhookEvent {
  provider: PaymentProviderName;
  type: 'charge_success' | 'subscription_create' | 'subscription_disable' | 'other';
  reference?: string;
  subscriptionCode?: string;
  planCode?: string;
  customerEmail?: string;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** Usable only when a secret key is resolved (admin sync or local env). */
  readonly enabled: boolean;
  /** Publishable key, safe to expose to the browser (may be empty). */
  readonly publicKey: string;

  initializeTransaction(input: InitializeTxnInput): Promise<InitializeTxnResult>;
  verifyTransaction(reference: string): Promise<VerifyTxnResult>;
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean;
  parseWebhookEvent(body: unknown): NormalizedWebhookEvent;

  /** Create (or reuse) a recurring plan for subscriptions. */
  ensurePlan(input: EnsurePlanInput): Promise<EnsurePlanResult>;
  /** Best-effort: fetch the subscription code for a customer on a plan. */
  findSubscriptionCode(customerCode: string, planCode: string): Promise<string | null>;
  /** Stop a recurring subscription so it no longer auto-charges. */
  disableSubscription(subscriptionCode: string): Promise<void>;
}
