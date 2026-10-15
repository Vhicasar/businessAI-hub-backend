import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { setMapsRuntime, type ConfiguredProvider } from '../../infrastructure/maps/registry';
import { MAPS_CAPABILITIES, type MapsCapability } from '../../infrastructure/maps/types';

/**
 * Pulls the maps providers this product may use from the Vhicasar Admin.
 *
 * Same shape as the AI, payment and OAuth syncs: the admin is the source of
 * truth, the deployment's own environment is the fallback, and an admin outage
 * never takes a working configuration away. A product that stopped being able
 * to geocode because a config server blinked would be worse than one that
 * never had central configuration at all.
 */

interface AdminProvider {
  provider: string;
  baseUrl: string | null;
  apiKey: string | null;
  publicToken: string | null;
  capabilities: string[];
  options: Record<string, unknown>;
  rateLimitPerMinute: number;
  cacheTtlSeconds: number;
  timeoutMs: number;
  monthlyRequestLimit: number;
  priority: number;
  attribution: string;
}

const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/**
 * What a deployment can do on its own, with no admin anywhere.
 *
 * The OpenStreetMap services first, because they are the only ones that work
 * without a credential — and they are only read from configuration, never
 * defaulted to a public endpoint, because those endpoints have usage policies
 * that forbid production autocomplete. A deployment that wants free address
 * search points these at its own Photon and OSRM.
 */
function fromEnvironment(): ConfiguredProvider[] {
  const out: ConfiguredProvider[] = [];
  const base = {
    apiKey: null,
    publicToken: null,
    options: {} as Record<string, unknown>,
    timeoutMs: 8000,
    rateLimitPerMinute: 0,
    cacheTtlSeconds: 86_400,
    monthlyRequestLimit: 0,
    attribution: OSM_ATTRIBUTION,
  };

  if (env.maps.photonUrl) {
    out.push({
      ...base,
      provider: 'photon',
      baseUrl: env.maps.photonUrl,
      capabilities: ['autocomplete', 'geocode', 'reverse_geocode'],
      priority: 10,
    });
  }

  if (env.maps.nominatimUrl) {
    out.push({
      ...base,
      provider: 'nominatim',
      baseUrl: env.maps.nominatimUrl,
      capabilities: ['geocode', 'reverse_geocode'],
      options: env.maps.contactEmail ? { email: env.maps.contactEmail } : {},
      // The project's own instance permits roughly one request a second, and
      // blocks callers who exceed it. Self-hosted deployments set no ceiling.
      rateLimitPerMinute: env.maps.nominatimUrl.includes('openstreetmap.org') ? 30 : 0,
      priority: 20,
    });
  }

  if (env.maps.osrmUrl) {
    out.push({
      ...base,
      provider: 'osrm',
      baseUrl: env.maps.osrmUrl,
      capabilities: ['route_distance'],
      rateLimitPerMinute: env.maps.osrmUrl.includes('project-osrm.org') ? 30 : 0,
      priority: 10,
    });
  }

  if (env.maps.apiKey && env.maps.provider !== 'none') {
    const commercial: Record<string, { base: string; attribution: string }> = {
      google: { base: 'https://maps.googleapis.com', attribution: 'Powered by Google' },
      mapbox: { base: 'https://api.mapbox.com', attribution: '© Mapbox © OpenStreetMap' },
      geoapify: { base: 'https://api.geoapify.com', attribution: `Powered by Geoapify · ${OSM_ATTRIBUTION}` },
      graphhopper: { base: 'https://graphhopper.com/api/1', attribution: `Powered by GraphHopper · ${OSM_ATTRIBUTION}` },
    };
    const meta = commercial[env.maps.provider];
    if (meta) {
      out.push({
        provider: env.maps.provider,
        baseUrl: meta.base,
        apiKey: env.maps.apiKey,
        publicToken: env.maps.publicToken || null,
        capabilities: ['autocomplete', 'place_details', 'geocode', 'reverse_geocode', 'route_distance'],
        options: env.maps.countryCodes ? { countryCodes: env.maps.countryCodes } : {},
        timeoutMs: 8000,
        rateLimitPerMinute: 0,
        // A day is inside every one of these providers' caching terms and
        // removes almost all repeat traffic. Google's cap is 30 days.
        cacheTtlSeconds: 86_400,
        monthlyRequestLimit: env.maps.monthlyLimit,
        priority: 50,
        attribution: meta.attribution,
      });
    }
  }

  return out;
}

function defaultOrder(providers: ConfiguredProvider[]): Record<string, string[]> {
  const order: Record<string, string[]> = {};
  for (const capability of MAPS_CAPABILITIES) {
    order[capability] = providers
      .filter((p) => p.capabilities.includes(capability))
      .sort((a, b) => a.priority - b.priority)
      .map((p) => p.provider);
  }
  return order;
}

export function applyEnvironmentFallback(): void {
  const providers = fromEnvironment();
  setMapsRuntime({ providers, order: defaultOrder(providers) });
  if (providers.length) {
    logger.info({ providers: providers.map((p) => p.provider) }, 'maps providers loaded from this deployment’s settings');
  }
}

export async function syncMapsConfigFromAdmin(): Promise<boolean> {
  if (!env.adminCatalog.apiUrl || !env.adminCatalog.tenantSlug || !env.service.apiKey) {
    applyEnvironmentFallback();
    return false;
  }

  const url = `${env.adminCatalog.apiUrl}/api/v1/service/${env.adminCatalog.tenantSlug}/maps-config`;
  try {
    const res = await fetch(url, {
      headers: { 'x-service-key': env.service.apiKey },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { providers?: AdminProvider[]; order?: Record<string, string[]> };
    };
    const remote = body?.data?.providers ?? [];

    if (remote.length === 0) {
      // The admin is reachable and has nothing configured. That is an answer,
      // not a failure — fall back to whatever this deployment has itself.
      applyEnvironmentFallback();
      return false;
    }

    const providers: ConfiguredProvider[] = remote
      .filter((p) => Boolean(p.baseUrl))
      .map((p) => ({
        provider: p.provider,
        baseUrl: p.baseUrl as string,
        apiKey: p.apiKey ?? null,
        publicToken: p.publicToken ?? null,
        capabilities: (p.capabilities ?? []).filter((c): c is MapsCapability =>
          (MAPS_CAPABILITIES as readonly string[]).includes(c),
        ),
        options: p.options ?? {},
        timeoutMs: p.timeoutMs || 8000,
        rateLimitPerMinute: p.rateLimitPerMinute ?? 0,
        cacheTtlSeconds: p.cacheTtlSeconds ?? 3600,
        monthlyRequestLimit: p.monthlyRequestLimit ?? 0,
        priority: p.priority ?? 100,
        attribution: p.attribution ?? '',
      }));

    setMapsRuntime({ providers, order: body.data?.order ?? defaultOrder(providers) });
    logger.info({ providers: providers.map((p) => p.provider) }, 'maps providers synced from admin');
    return true;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'maps config sync failed — using this deployment’s own settings',
    );
    applyEnvironmentFallback();
    return false;
  }
}

export async function startMapsConfigSync(): Promise<void> {
  await syncMapsConfigFromAdmin();
  const ms = env.adminAi.intervalMin * 60_000;
  if (ms > 0) setInterval(() => void syncMapsConfigFromAdmin(), ms).unref();
}
