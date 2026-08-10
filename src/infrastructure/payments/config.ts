import { env } from '../../shared/config/env';
import type { PaymentProviderName } from './types';

/**
 * Resolves the *active* payment provider and its credentials. The admin
 * (Vhicasar) is the source of truth: `payment-config-sync` fetches the active
 * provider + keys and installs them here as an override. When the admin has
 * nothing configured or is unreachable, we fall back to the local BILLING_* /
 * PAYSTACK_* / FLUTTERWAVE_* env — payments must never break because the admin
 * is down. Mirrors the AI provider override in `infrastructure/ai`.
 */

export interface PaymentConfigOverride {
  provider: PaymentProviderName;
  secretKey: string | null;
  webhookSecret: string | null;
  publicKey: string | null;
  /** See ResolvedPaymentConfig.merchantId. */
  merchantId?: string | null;
  chargeCurrencies: string[];
  callbackUrl: string | null;
}

export interface ResolvedPaymentConfig {
  provider: PaymentProviderName;
  secretKey: string;
  webhookSecret: string;
  publicKey: string;
  /**
   * A third account identifier some gateways need alongside the key pair,
   * because the keys alone do not say which account to credit:
   *
   *   - OPay      → Merchant ID, sent in the `MerchantId` header
   *   - Moniepoint → Monnify Contract Code, sent in the request body
   *
   * Empty for gateways that identify the merchant from the secret key alone
   * (Paystack, Flutterwave, Stripe).
   */
  merchantId: string;
  chargeCurrencies: string[];
  callbackUrl: string;
}

let override: PaymentConfigOverride | null = null;

/** Install (or clear with null) the admin-synced active provider config. */
export function setPaymentConfigOverride(cfg: PaymentConfigOverride | null): void {
  override = cfg;
}

function localSecret(provider: PaymentProviderName): string {
  return provider === 'flutterwave' ? env.billing.flutterwaveSecretKey
    : provider === 'stripe' ? env.billing.stripeSecretKey
    : env.billing.paystackSecretKey;
}

function localPublic(provider: PaymentProviderName): string {
  return provider === 'flutterwave' ? env.billing.flutterwavePublicKey
    : provider === 'stripe' ? env.billing.stripePublicKey
    : env.billing.paystackPublicKey;
}

/** The resolved active provider config used by every checkout. */
export function getPaymentConfig(): ResolvedPaymentConfig {
  const provider: PaymentProviderName = override?.provider ?? env.billing.provider;
  // Once the admin selects a provider it is authoritative. Do not silently
  // borrow a local key when the selected admin config is incomplete.
  const secretKey = override ? override.secretKey || '' : localSecret(provider);
  const publicKey = override ? override.publicKey || '' : localPublic(provider);
  const webhookSecret =
    override
      ? override.webhookSecret || ''
      : provider === 'flutterwave'
        ? env.billing.flutterwaveSecretHash
        : provider === 'stripe'
          ? env.billing.stripeWebhookSecret
          : '';
  const chargeCurrencies =
    override && override.chargeCurrencies.length > 0
      ? override.chargeCurrencies.map((c) => c.toUpperCase())
      : env.billing.chargeCurrencies;
  const callbackUrl = override?.callbackUrl || env.billing.callbackUrl;
  const merchantId = override?.merchantId || '';
  return { provider, secretKey, webhookSecret, publicKey, merchantId, chargeCurrencies, callbackUrl };
}

/** Currencies the active merchant account can settle. */
export function getChargeCurrencies(): string[] {
  return getPaymentConfig().chargeCurrencies;
}
