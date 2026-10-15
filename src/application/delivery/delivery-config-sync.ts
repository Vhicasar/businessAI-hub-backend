import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';

/**
 * Which delivery services this product may offer its businesses.
 *
 * Pulled from the Vhicasar Admin, which owns the decision: whether a service
 * is offered at all, whether businesses may use the platform's own account,
 * and whether they may connect their own instead. The product enforces those
 * answers; it does not make them.
 *
 * Falls back to the two that need nobody's permission — the customer
 * collecting, and the business delivering on its own rates. A business must
 * not lose the ability to sell for collection because a config server is
 * briefly unreachable.
 */

export interface PlatformDeliveryService {
  provider: string;
  label: string | null;
  /** rate_quote | dispatch | tracking | labels */
  capabilities: string[];
  /** ISO codes this service covers. Empty means unrestricted. */
  countries: string[];
  baseUrl: string | null;
  /** The platform's own credential. Never leaves the backend. */
  apiKey: string | null;
  options: Record<string, unknown>;
  allowBusinessCredentials: boolean;
  allowPlatformCredentials: boolean;
  businessSelectable: boolean;
  supportsBusinessCredentials: boolean;
}

/** Collection and own-delivery, which the product serves entirely itself. */
const SELF_SERVED: PlatformDeliveryService[] = [
  {
    provider: 'pickup',
    label: 'Customer collection',
    capabilities: [],
    countries: [],
    baseUrl: null,
    apiKey: null,
    options: {},
    allowBusinessCredentials: false,
    allowPlatformCredentials: false,
    businessSelectable: true,
    supportsBusinessCredentials: false,
  },
  {
    provider: 'manual',
    label: 'The business delivers it itself',
    capabilities: ['rate_quote'],
    countries: [],
    baseUrl: null,
    apiKey: null,
    options: {},
    allowBusinessCredentials: false,
    allowPlatformCredentials: false,
    businessSelectable: true,
    supportsBusinessCredentials: false,
  },
];

let services: PlatformDeliveryService[] = SELF_SERVED;

export function setDeliveryServices(next: PlatformDeliveryService[] | null): void {
  const incoming = next ?? [];
  // Collection and own-delivery are always present: they need no credential
  // and no third party, so there is nothing an outage could take away.
  const byProvider = new Map(SELF_SERVED.map((s) => [s.provider, s]));
  for (const service of incoming) byProvider.set(service.provider, service);
  services = [...byProvider.values()];
}

/** Everything the platform permits, including non-selectable entries. */
export function platformDeliveryServices(): PlatformDeliveryService[] {
  return services;
}

/** What a business may actually choose between. */
export function selectableDeliveryServices(country?: string | null): PlatformDeliveryService[] {
  const code = country?.trim().toUpperCase();
  return services.filter((service) => {
    if (!service.businessSelectable) return false;
    if (!service.countries.length || !code) return true;
    return service.countries.includes(code);
  });
}

export function deliveryServiceByProvider(provider: string): PlatformDeliveryService | null {
  return services.find((s) => s.provider === provider) ?? null;
}

export async function syncDeliveryConfigFromAdmin(): Promise<boolean> {
  if (!env.adminCatalog.apiUrl || !env.adminCatalog.tenantSlug || !env.service.apiKey) {
    setDeliveryServices(null);
    return false;
  }
  const url = `${env.adminCatalog.apiUrl}/api/v1/service/${env.adminCatalog.tenantSlug}/delivery-config`;
  try {
    const res = await fetch(url, {
      headers: { 'x-service-key': env.service.apiKey },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { services?: PlatformDeliveryService[] } };
    setDeliveryServices(body?.data?.services ?? []);
    logger.info(
      { services: platformDeliveryServices().map((s) => s.provider) },
      'delivery services synced from admin',
    );
    return true;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'delivery config sync failed — collection and own-delivery remain available',
    );
    setDeliveryServices(null);
    return false;
  }
}

export async function startDeliveryConfigSync(): Promise<void> {
  await syncDeliveryConfigFromAdmin();
  const ms = env.adminAi.intervalMin * 60_000;
  if (ms > 0) setInterval(() => void syncDeliveryConfigFromAdmin(), ms).unref();
}
