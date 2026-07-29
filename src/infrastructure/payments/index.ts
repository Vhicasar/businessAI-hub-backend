import { paystack, PaystackClient } from './paystack';
import { flutterwave, FlutterwaveClient } from './flutterwave';
import { getPaymentConfig, type ResolvedPaymentConfig } from './config';
import type { PaymentProvider } from './types';

/**
 * Returns the single active payment provider chosen by the admin (falling back
 * to the local BILLING_PROVIDER env). All *platform* checkout, verify and
 * subscription flows go through this so no consumer hard-codes a gateway.
 */
export function getActivePaymentProvider(): PaymentProvider {
  return getPaymentConfig().provider === 'flutterwave' ? flutterwave : paystack;
}

/**
 * Build a provider bound to an explicit merchant config — used for per-org
 * customer collections (payment links) so funds settle into the tenant's own
 * Paystack/Flutterwave account rather than the platform's.
 */
export function buildPaymentProvider(cfg: ResolvedPaymentConfig): PaymentProvider {
  return cfg.provider === 'flutterwave'
    ? new FlutterwaveClient(() => cfg)
    : new PaystackClient(() => cfg);
}

export { paystack, flutterwave };
export { getPaymentConfig, getChargeCurrencies, setPaymentConfigOverride } from './config';
export type { ResolvedPaymentConfig, PaymentConfigOverride } from './config';
export * from './types';
