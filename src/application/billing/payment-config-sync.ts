import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { setPaymentConfigOverride } from '../../infrastructure/payments';
import type { PaymentProviderName } from '../../infrastructure/payments';

/**
 * Pulls this product's ACTIVE payment provider + credentials from the Vhicasar
 * Admin's authenticated service API and applies them, so the gateway and keys
 * are managed centrally rather than per-deployment env. Falls back to the local
 * BILLING_PROVIDER / PAYSTACK_* / FLUTTERWAVE_* env when the admin has nothing
 * configured (404) or is unreachable — payments must never break because the
 * admin is down. Mirrors `ai/ai-sync.ts`.
 */
interface AdminPaymentConfig {
  provider: string;
  secretKey: string | null;
  webhookSecret: string | null;
  publicKey: string | null;
  chargeCurrencies: string[];
  callbackUrl: string | null;
}

const SUPPORTED: PaymentProviderName[] = ['paystack', 'flutterwave', 'stripe'];
let lastSyncAt = 0;
let inFlight: Promise<boolean> | null = null;

export async function syncPaymentConfigFromAdmin(): Promise<boolean> {
  if (!env.billing.adminSync) return false;
  const url = `${env.adminCatalog.apiUrl}/api/v1/service/${env.adminCatalog.tenantSlug}/payment-config`;
  try {
    const res = await fetch(url, {
      headers: { 'x-service-key': env.service.apiKey },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404) {
      // Nothing configured in the admin — use local env.
      setPaymentConfigOverride(null);
      return false;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: AdminPaymentConfig };
    const cfg = body?.data;
    if (!cfg?.provider || !SUPPORTED.includes(cfg.provider as PaymentProviderName)) {
      setPaymentConfigOverride(null);
      return false;
    }
    setPaymentConfigOverride({
      provider: cfg.provider as PaymentProviderName,
      secretKey: cfg.secretKey ?? null,
      webhookSecret: cfg.webhookSecret ?? null,
      publicKey: cfg.publicKey ?? null,
      chargeCurrencies: Array.isArray(cfg.chargeCurrencies) ? cfg.chargeCurrencies : [],
      callbackUrl: cfg.callbackUrl ?? null,
    });
    logger.info(`Payment config synced from admin: ${cfg.provider}`);
    lastSyncAt = Date.now();
    return true;
  } catch (err) {
    logger.warn({ err }, 'Payment config sync from admin failed — keeping local billing env');
    return false;
  }
}

/** Refresh admin gateway selection on billing reads/checkouts without making
 * every request wait on the admin service. */
export async function ensureFreshPaymentConfig(maxAgeMs = 30_000): Promise<void> {
  if (!env.billing.adminSync || Date.now() - lastSyncAt < maxAgeMs) return;
  if (!inFlight) {
    inFlight = syncPaymentConfigFromAdmin().finally(() => {
      lastSyncAt = Date.now();
      inFlight = null;
    });
  }
  await inFlight;
}

/** Initial sync (best-effort) plus periodic refresh, mirroring ai-sync. */
export async function startPaymentConfigSync(): Promise<void> {
  if (!env.billing.adminSync) return;
  await syncPaymentConfigFromAdmin();
  const ms = env.adminAi.intervalMin * 60_000;
  if (ms > 0) setInterval(() => void syncPaymentConfigFromAdmin(), ms).unref();
}
