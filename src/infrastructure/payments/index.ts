import { paystack } from './paystack';
import { flutterwave } from './flutterwave';
import { getPaymentConfig } from './config';
import type { PaymentProvider } from './types';

/**
 * Returns the single active payment provider chosen by the admin (falling back
 * to the local BILLING_PROVIDER env). All checkout, verify and subscription
 * flows go through this so no consumer hard-codes a gateway.
 */
export function getActivePaymentProvider(): PaymentProvider {
  return getPaymentConfig().provider === 'flutterwave' ? flutterwave : paystack;
}

export { paystack, flutterwave };
export { getPaymentConfig, getChargeCurrencies, setPaymentConfigOverride } from './config';
export * from './types';
