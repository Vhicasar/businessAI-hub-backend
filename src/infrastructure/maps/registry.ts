import { logger } from '../../shared/logger';
import { nominatimAdapter, photonAdapter, osrmAdapter } from './adapters/osm';
import { geoapifyAdapter, graphhopperAdapter, mapboxAdapter, googleAdapter } from './adapters/commercial';
import {
  ProviderError,
  type MapsAdapter,
  type MapsCapability,
  type ProviderRuntime,
} from './types';

/**
 * Which adapters exist, and what this platform is currently allowed to use.
 *
 * The adapter list is code; the runtime list is configuration, pushed in by
 * the admin sync. Keeping them apart is what lets an operator switch providers
 * without a deploy, and what stops a provider appearing available because its
 * adapter happens to be compiled in.
 */

const ADAPTERS: Record<string, MapsAdapter> = {
  nominatim: nominatimAdapter,
  photon: photonAdapter,
  osrm: osrmAdapter,
  geoapify: geoapifyAdapter,
  graphhopper: graphhopperAdapter,
  mapbox: mapboxAdapter,
  google: googleAdapter,
};

export interface ConfiguredProvider extends ProviderRuntime {
  capabilities: MapsCapability[];
  rateLimitPerMinute: number;
  cacheTtlSeconds: number;
  monthlyRequestLimit: number;
  priority: number;
}

interface Runtime {
  providers: ConfiguredProvider[];
  /** Capability → provider ids, best first. */
  order: Record<string, string[]>;
}

let runtime: Runtime = { providers: [], order: {} };

export function setMapsRuntime(next: Runtime | null): void {
  runtime = next ?? { providers: [], order: {} };
}

export function mapsRuntime(): Runtime {
  return runtime;
}

/** Whether anything at all can serve this capability. */
export function capabilityAvailable(capability: MapsCapability): boolean {
  return chain(capability).length > 0;
}

/**
 * The providers to try for a capability, in order.
 *
 * Only ones whose adapter implements the method, whose configuration says they
 * may do this job, and which are not currently over a limit. A provider that
 * fails every check is simply not in the chain, which is why there is no
 * infinite fallback: the list is finite and each entry is tried once.
 */
function chain(capability: MapsCapability): ConfiguredProvider[] {
  const preferred = runtime.order[capability] ?? [];
  const byId = new Map(runtime.providers.map((p) => [p.provider, p]));
  const ordered = [
    ...preferred.map((id) => byId.get(id)).filter(Boolean),
    ...runtime.providers.filter((p) => !preferred.includes(p.provider)).sort((a, b) => a.priority - b.priority),
  ] as ConfiguredProvider[];

  const seen = new Set<string>();
  return ordered.filter((provider) => {
    if (seen.has(provider.provider)) return false;
    seen.add(provider.provider);
    if (!provider.capabilities.includes(capability)) return false;
    const adapter = ADAPTERS[provider.provider];
    if (!adapter) return false;
    return typeof adapter[METHOD[capability]] === 'function';
  });
}

const METHOD: Record<MapsCapability, keyof MapsAdapter> = {
  autocomplete: 'autocomplete',
  place_details: 'placeDetails',
  geocode: 'geocode',
  reverse_geocode: 'reverseGeocode',
  route_distance: 'routeDistance',
  // No call to make: tiles are rendered by the browser from the public token.
  map_tiles: 'id',
};

/* ───────────────────────── usage accounting ───────────────────────── */

interface Window {
  minute: number;
  minuteCount: number;
  month: string;
  monthCount: number;
}

const usage = new Map<string, Window>();

function monthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
}

/**
 * Whether this provider may be asked one more question right now.
 *
 * Two ceilings, for two different accidents: a per-minute rate that keeps a
 * burst of typing from tripping a provider's own limiter, and a monthly count
 * that keeps a loop — or a scraper on a public autocomplete endpoint — from
 * running up a bill nobody authorised.
 */
function allow(provider: ConfiguredProvider): boolean {
  const minute = Math.floor(Date.now() / 60_000);
  const month = monthKey();
  const current = usage.get(provider.provider) ?? { minute, minuteCount: 0, month, monthCount: 0 };
  if (current.minute !== minute) {
    current.minute = minute;
    current.minuteCount = 0;
  }
  if (current.month !== month) {
    current.month = month;
    current.monthCount = 0;
  }
  if (provider.rateLimitPerMinute > 0 && current.minuteCount >= provider.rateLimitPerMinute) return false;
  if (provider.monthlyRequestLimit > 0 && current.monthCount >= provider.monthlyRequestLimit) return false;
  current.minuteCount += 1;
  current.monthCount += 1;
  usage.set(provider.provider, current);
  return true;
}

export function usageSnapshot(): { provider: string; thisMinute: number; thisMonth: number }[] {
  return [...usage.entries()].map(([provider, w]) => ({
    provider,
    thisMinute: w.minute === Math.floor(Date.now() / 60_000) ? w.minuteCount : 0,
    thisMonth: w.month === monthKey() ? w.monthCount : 0,
  }));
}

/** Visible for testing. */
export function resetUsage(): void {
  usage.clear();
}

/* ──────────────────────────── caching ──────────────────────────── */

interface CacheEntry {
  at: number;
  ttlMs: number;
  value: unknown;
}

const CACHE_MAX = 2000;
const cache = new Map<string, CacheEntry>();

function cacheGet<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttlMs) {
    cache.delete(key);
    return null;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: unknown, ttlSeconds: number): void {
  // Zero means the provider's terms forbid keeping it, so nothing is kept.
  if (ttlSeconds <= 0) return;
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), ttlMs: ttlSeconds * 1000, value });
}

export function clearMapsCache(): void {
  cache.clear();
}

/* ──────────────────────────── dispatch ──────────────────────────── */

export interface Served<T> {
  value: T;
  /** Which provider actually answered — for attribution and accounting. */
  provider: string;
  attribution: string;
  /** True when the answer came from the cache rather than the provider. */
  cached: boolean;
}

export class NoProviderError extends Error {
  constructor(capability: MapsCapability, readonly reasons: string[]) {
    super(
      reasons.length
        ? `No maps provider could serve ${capability}: ${reasons.join('; ')}`
        : `No maps provider is configured for ${capability}`,
    );
    this.name = 'NoProviderError';
  }
}

/**
 * Ask the chain, in order, until one answers.
 *
 * A provider that refuses on credentials is not retried and not fallen back
 * *past* silently — the reason is collected and reported if nothing else
 * works, because "no results" and "your key is wrong" need different fixes.
 */
export async function serve<T>(
  capability: MapsCapability,
  cacheKey: string | null,
  call: (adapter: MapsAdapter, runtime: ConfiguredProvider) => Promise<T>,
): Promise<Served<T>> {
  const providers = chain(capability);
  const reasons: string[] = [];

  for (const provider of providers) {
    const key = cacheKey ? `${capability}:${provider.provider}:${cacheKey}` : null;
    if (key) {
      const hit = cacheGet<T>(key);
      if (hit !== null) {
        return { value: hit, provider: provider.provider, attribution: provider.attribution, cached: true };
      }
    }

    if (!allow(provider)) {
      reasons.push(`${provider.provider} is over its configured usage limit`);
      continue;
    }

    try {
      const value = await call(ADAPTERS[provider.provider]!, provider);
      if (key) cacheSet(key, value, provider.cacheTtlSeconds);
      return { value, provider: provider.provider, attribution: provider.attribution, cached: false };
    } catch (err) {
      const reason =
        err instanceof ProviderError ? err.message : `${provider.provider} failed unexpectedly`;
      reasons.push(reason);
      logger.warn({ provider: provider.provider, capability, reason }, 'maps provider failed; trying the next');
    }
  }

  throw new NoProviderError(capability, reasons);
}

/** For the admin screens and health checks. */
export function configuredProviders(): { provider: string; capabilities: MapsCapability[]; hasKey: boolean }[] {
  return runtime.providers.map((p) => ({
    provider: p.provider,
    capabilities: p.capabilities,
    hasKey: Boolean(p.apiKey),
  }));
}
