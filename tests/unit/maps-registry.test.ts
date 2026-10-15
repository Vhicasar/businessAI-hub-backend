import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import {
  setMapsRuntime,
  serve,
  capabilityAvailable,
  resetUsage,
  clearMapsCache,
  NoProviderError,
  type ConfiguredProvider,
} from '../../src/infrastructure/maps/registry';
import { ProviderError } from '../../src/infrastructure/maps/types';

/**
 * Choosing a provider, failing over, and knowing when to stop.
 *
 * None of this talks to a provider: the adapters are driven through `serve`,
 * which is where the decisions live. What is asserted is which provider got
 * asked, in what order, and what happened when one refused.
 */

const provider = (overrides: Partial<ConfiguredProvider>): ConfiguredProvider => ({
  provider: 'photon',
  baseUrl: 'https://example.test',
  apiKey: null,
  publicToken: null,
  capabilities: ['autocomplete', 'geocode'],
  options: {},
  timeoutMs: 1000,
  rateLimitPerMinute: 0,
  cacheTtlSeconds: 60,
  monthlyRequestLimit: 0,
  priority: 10,
  attribution: '© OpenStreetMap contributors',
  ...overrides,
});

beforeEach(() => {
  resetUsage();
  clearMapsCache();
});

afterEach(() => setMapsRuntime(null));

describe('capability availability', () => {
  it('is false when nothing is configured', () => {
    setMapsRuntime(null);
    expect(capabilityAvailable('autocomplete')).toBe(false);
  });

  it('is false for a capability the configured provider does not have', () => {
    setMapsRuntime({ providers: [provider({ provider: 'osrm', capabilities: ['route_distance'] })], order: {} });
    expect(capabilityAvailable('route_distance')).toBe(true);
    // OSRM routes between points and cannot search addresses. Saying otherwise
    // would offer an autocomplete box that fails on the first keystroke.
    expect(capabilityAvailable('autocomplete')).toBe(false);
  });

  it('ignores a provider whose adapter does not exist', () => {
    setMapsRuntime({ providers: [provider({ provider: 'not-a-real-adapter' })], order: {} });
    expect(capabilityAvailable('autocomplete')).toBe(false);
  });
});

describe('provider resolution', () => {
  it('asks the operator’s first choice first', async () => {
    setMapsRuntime({
      providers: [provider({ provider: 'photon', priority: 50 }), provider({ provider: 'nominatim', priority: 10 })],
      order: { autocomplete: ['photon'] },
    });
    const asked: string[] = [];
    const served = await serve('autocomplete', null, async (_adapter, runtime) => {
      asked.push(runtime.provider);
      return [];
    });
    // Priority would have chosen nominatim; the configured order wins.
    expect(asked).toEqual(['photon']);
    expect(served.provider).toBe('photon');
  });

  it('falls back to priority when nobody expressed a preference', async () => {
    setMapsRuntime({
      providers: [provider({ provider: 'photon', priority: 50 }), provider({ provider: 'nominatim', priority: 10 })],
      order: {},
    });
    const served = await serve('autocomplete', null, async () => []);
    expect(served.provider).toBe('nominatim');
  });

  it('moves to the next provider when one fails', async () => {
    setMapsRuntime({
      providers: [provider({ provider: 'photon' }), provider({ provider: 'nominatim' })],
      order: { autocomplete: ['photon', 'nominatim'] },
    });
    const asked: string[] = [];
    const served = await serve('autocomplete', null, async (_adapter, runtime) => {
      asked.push(runtime.provider);
      if (runtime.provider === 'photon') throw new ProviderError('down', 'network', true);
      return [];
    });
    expect(asked).toEqual(['photon', 'nominatim']);
    expect(served.provider).toBe('nominatim');
  });

  it('tries each provider once and then gives up', async () => {
    setMapsRuntime({
      providers: [provider({ provider: 'photon' }), provider({ provider: 'nominatim' })],
      order: { autocomplete: ['photon', 'nominatim', 'photon'] },
    });
    const asked: string[] = [];
    await expect(
      serve('autocomplete', null, async (_adapter, runtime) => {
        asked.push(runtime.provider);
        throw new ProviderError('down', 'network', true);
      }),
    ).rejects.toBeInstanceOf(NoProviderError);
    // A duplicate in the configured order must not become a second attempt.
    expect(asked).toEqual(['photon', 'nominatim']);
  });

  it('reports why nothing worked, rather than returning nothing', async () => {
    setMapsRuntime({ providers: [provider({ provider: 'photon' })], order: {} });
    await expect(
      serve('autocomplete', null, async () => {
        throw new ProviderError('photon rejected the credentials', 'auth', false);
      }),
    ).rejects.toThrow(/rejected the credentials/);
  });

  it('refuses when nothing is configured at all', async () => {
    setMapsRuntime(null);
    await expect(serve('geocode', null, async () => null)).rejects.toThrow(/No maps provider is configured/);
  });
});

describe('usage limits', () => {
  it('stops asking a provider once its per-minute cap is reached', async () => {
    setMapsRuntime({
      providers: [provider({ provider: 'photon', rateLimitPerMinute: 2 })],
      order: {},
    });
    const call = () => serve('autocomplete', null, async () => []);
    await call();
    await call();
    await expect(call()).rejects.toThrow(/over its configured usage limit/);
  });

  it('falls through to another provider when the first is capped', async () => {
    setMapsRuntime({
      providers: [
        provider({ provider: 'photon', rateLimitPerMinute: 1 }),
        provider({ provider: 'nominatim' }),
      ],
      order: { autocomplete: ['photon', 'nominatim'] },
    });
    expect((await serve('autocomplete', null, async () => [])).provider).toBe('photon');
    // The cap is a reason to use the next provider, not a reason to fail.
    expect((await serve('autocomplete', null, async () => [])).provider).toBe('nominatim');
  });

  it('honours a monthly ceiling on billable requests', async () => {
    setMapsRuntime({ providers: [provider({ provider: 'google', monthlyRequestLimit: 1 })], order: {} });
    await serve('autocomplete', null, async () => []);
    await expect(serve('autocomplete', null, async () => [])).rejects.toThrow(/usage limit/);
  });
});

describe('caching', () => {
  it('answers a repeat question without asking the provider again', async () => {
    setMapsRuntime({ providers: [provider({ cacheTtlSeconds: 60 })], order: {} });
    const call = vi.fn(async () => ['one']);
    const first = await serve('autocomplete', 'lagos', call);
    const second = await serve('autocomplete', 'lagos', call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.value).toEqual(['one']);
  });

  it('keeps nothing when the provider’s terms forbid it', async () => {
    setMapsRuntime({ providers: [provider({ cacheTtlSeconds: 0 })], order: {} });
    const call = vi.fn(async () => ['one']);
    await serve('autocomplete', 'lagos', call);
    await serve('autocomplete', 'lagos', call);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not serve one provider’s answer as another’s', async () => {
    setMapsRuntime({
      providers: [provider({ provider: 'photon' }), provider({ provider: 'nominatim' })],
      order: { autocomplete: ['photon'] },
    });
    await serve('autocomplete', 'lagos', async () => ['photon-answer']);
    setMapsRuntime({
      providers: [provider({ provider: 'nominatim' })],
      order: { autocomplete: ['nominatim'] },
    });
    const second = await serve('autocomplete', 'lagos', async () => ['nominatim-answer']);
    expect(second.cached).toBe(false);
    expect(second.value).toEqual(['nominatim-answer']);
  });
});

describe('attribution', () => {
  it('travels with every answer, cached or not', async () => {
    setMapsRuntime({ providers: [provider({ attribution: '© OpenStreetMap contributors' })], order: {} });
    const first = await serve('autocomplete', 'ikeja', async () => []);
    const second = await serve('autocomplete', 'ikeja', async () => []);
    expect(first.attribution).toBe('© OpenStreetMap contributors');
    expect(second.attribution).toBe('© OpenStreetMap contributors');
  });
});
