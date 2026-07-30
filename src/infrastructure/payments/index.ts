import { paystack, PaystackClient } from './paystack';
import { flutterwave, FlutterwaveClient } from './flutterwave';
import { stripe, StripeClient } from './stripe';
import { getPaymentConfig, type ResolvedPaymentConfig } from './config';
import type { PaymentProvider } from './types';

/**
 * Returns the single active payment provider chosen by the admin (falling back
 * to the local BILLING_PROVIDER env). All *platform* checkout, verify and
 * subscription flows go through this so no consumer hard-codes a gateway.
 */
export function getActivePaymentProvider(): PaymentProvider {
  const p = getPaymentConfig().provider;
  return p === 'flutterwave' ? flutterwave : p === 'stripe' ? stripe : paystack;
}

/**
 * Build a provider bound to an explicit merchant config — used for per-org
 * customer collections (payment links) so funds settle into the tenant's own
 * Paystack/Flutterwave account rather than the platform's.
 */
export function buildPaymentProvider(cfg: ResolvedPaymentConfig): PaymentProvider {
  return cfg.provider === 'flutterwave'
    ? new FlutterwaveClient(() => cfg)
    : cfg.provider === 'stripe'
      ? new StripeClient(() => cfg)
      : new PaystackClient(() => cfg);
}

export { paystack, flutterwave, stripe };
export { getPaymentConfig, getChargeCurrencies, setPaymentConfigOverride } from './config';
export type { ResolvedPaymentConfig, PaymentConfigOverride } from './config';
export * from './types';
