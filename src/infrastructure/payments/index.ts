import { paystack, PaystackClient } from './paystack';
import { flutterwave, FlutterwaveClient } from './flutterwave';
import { stripe, StripeClient } from './stripe';
import { opay, OpayClient } from './opay';
import { moniepoint, MoniepointClient } from './moniepoint';
import { getPaymentConfig, type ResolvedPaymentConfig } from './config';
import type { PaymentProvider } from './types';

/**
 * Returns the single active payment provider chosen by the admin (falling back
 * to the local BILLING_PROVIDER env). All *platform* checkout, verify and
 * subscription flows go through this so no consumer hard-codes a gateway.
 */
export function getActivePaymentProvider(): PaymentProvider {
  const p = getPaymentConfig().provider;
  return p === 'flutterwave' ? flutterwave
    : p === 'stripe' ? stripe
    : p === 'opay' ? opay
    : p === 'moniepoint' ? moniepoint
    : paystack;
}

/**
 * Build a provider bound to an explicit merchant config — used for per-org
 * customer collections (payment links) so funds settle into the tenant's own
 * Paystack/Flutterwave account rather than the platform's.
 */
export function buildPaymentProvider(cfg: ResolvedPaymentConfig): PaymentProvider {
  switch (cfg.provider) {
    case 'flutterwave':
      return new FlutterwaveClient(() => cfg);
    case 'stripe':
      return new StripeClient(() => cfg);
    case 'opay':
      return new OpayClient(() => cfg);
    case 'moniepoint':
      return new MoniepointClient(() => cfg);
    default:
      return new PaystackClient(() => cfg);
  }
}

export { paystack, flutterwave, stripe, opay, moniepoint };
export { getPaymentConfig, getChargeCurrencies, setPaymentConfigOverride } from './config';
export type { ResolvedPaymentConfig, PaymentConfigOverride } from './config';
export * from './types';
