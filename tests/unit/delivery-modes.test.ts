import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quoteDelivery } from '../../src/application/delivery/delivery-pricing.service';
import {
  fulfilmentSettingsSchema,
  type FulfilmentConfig,
} from '../../src/application/delivery/fulfilment-settings.service';
import {
  setDeliveryServices,
  selectableDeliveryServices,
  deliveryServiceByProvider,
} from '../../src/application/delivery/delivery-config-sync';
import { setMapsRuntime } from '../../src/infrastructure/maps/registry';

/**
 * How an order gets priced, depending on who is doing the pricing.
 *
 * Three different answers to one question, and the point of the tests is that
 * they stay different: a business's own rates are computed here, a courier's
 * are not computed at all, and a business that prices by hand charges nothing
 * at checkout.
 */

function config(delivery: Record<string, unknown> = {}): FulfilmentConfig {
  const parsed = fulfilmentSettingsSchema.parse({
    pickup: {
      enabled: true,
      address: { line1: '1 Market Road', city: 'Lagos', country: 'NG' },
      coordinates: { latitude: 6.5244, longitude: 3.3792 },
    },
    delivery: {
      enabled: true,
      originSameAsPickup: true,
      pricing: { baseFee: 1000, perKm: 0, perKg: 0, minFee: 0 },
      ...delivery,
    },
  });
  return {
    ...parsed,
    currency: 'NGN',
    mapsConfigured: false,
    businessAddress: { line1: '', line2: '', city: '', state: '', country: 'NG', postalCode: '' },
    businessCoordinates: { latitude: null, longitude: null },
  };
}

const destination = {
  address: { line1: '12 Allen Avenue', line2: '', city: 'Ikeja', state: 'Lagos', country: 'NG', postalCode: '' },
  latitude: 6.6018,
  longitude: 3.3515,
};

const quote = (cfg: FulfilmentConfig) =>
  quoteDelivery({ organizationId: 'org-test', items: [], destination, config: cfg });

const fetchMock = vi.fn();

beforeEach(() => {
  setMapsRuntime(null);
  setDeliveryServices(null);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setDeliveryServices(null);
});

describe('what the platform offers a business', () => {
  it('always offers collection and the business’s own delivery', () => {
    // Even with no admin reachable: neither needs a credential or a third party.
    const offered = selectableDeliveryServices('NG').map((s) => s.provider);
    expect(offered).toContain('pickup');
    expect(offered).toContain('manual');
  });

  it('hides a service the platform has not made selectable', () => {
    setDeliveryServices([
      {
        provider: 'http_carrier', label: 'Courier', capabilities: ['rate_quote'], countries: [],
        baseUrl: null, apiKey: null, options: {}, allowBusinessCredentials: false,
        allowPlatformCredentials: true, businessSelectable: false, supportsBusinessCredentials: true,
      },
    ]);
    expect(selectableDeliveryServices('NG').map((s) => s.provider)).not.toContain('http_carrier');
  });

  it('hides a service that does not cover the business’s country', () => {
    setDeliveryServices([
      {
        provider: 'http_carrier', label: 'Courier', capabilities: ['rate_quote'], countries: ['GB'],
        baseUrl: null, apiKey: null, options: {}, allowBusinessCredentials: false,
        allowPlatformCredentials: true, businessSelectable: true, supportsBusinessCredentials: true,
      },
    ]);
    expect(selectableDeliveryServices('NG').map((s) => s.provider)).not.toContain('http_carrier');
    expect(selectableDeliveryServices('GB').map((s) => s.provider)).toContain('http_carrier');
  });
});

describe('mode A — the business’s own rates', () => {
  it('computes the fee from what the business configured', async () => {
    const result = await quote(config({ mode: 'BUSINESS_RATES', pricing: { baseFee: 1500, perKm: 0, perKg: 0 } }));
    expect(result.outcome).toBe('OK');
    expect(result.fee.total).toBe(1500);
    expect(result.pricedBy.mode).toBe('BUSINESS_RATES');
    expect(result.pricedBy.provider).toBeNull();
  });
});

describe('mode D — priced by hand', () => {
  it('charges nothing at checkout and says what happens next', async () => {
    const result = await quote(
      config({ mode: 'MANUAL_ONLY', manualQuoteMessage: 'We will call you with a price.' }),
    );
    expect(result.outcome).toBe('MANUAL_QUOTE');
    expect(result.priced).toBe(false);
    // The important half: no number is invented to fill the gap.
    expect(result.fee.total).toBe(0);
    expect(result.message).toBe('We will call you with a price.');
  });
});

describe('mode B/C — a courier quotes it', () => {
  const carrier = (overrides: Record<string, unknown> = {}) => {
    setDeliveryServices([
      {
        provider: 'http_carrier',
        label: 'Swift Couriers',
        capabilities: ['rate_quote', 'dispatch'],
        countries: [],
        baseUrl: null,
        apiKey: 'platform-key',
        options: { rateUrl: 'https://courier.test/rates', amountPath: 'amount' },
        allowBusinessCredentials: true,
        allowPlatformCredentials: true,
        businessSelectable: true,
        supportsBusinessCredentials: true,
        ...overrides,
      },
    ]);
  };

  it('uses the courier’s price, not the business’s rate card', async () => {
    carrier();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ amount: 3250, currency: 'NGN', reference: 'q-1' }) });
    const result = await quote(
      config({ mode: 'CARRIER', carrierProvider: 'http_carrier', pricing: { baseFee: 9999, perKm: 500, perKg: 500 } }),
    );
    expect(result.outcome).toBe('OK');
    // The business's own base fee is deliberately ignored: the courier has
    // already priced the journey, and adding to it charges twice.
    expect(result.fee.total).toBe(3250);
    expect(result.pricedBy).toMatchObject({ mode: 'CARRIER', provider: 'http_carrier', reference: 'q-1' });
  });

  it('does not claim to have measured a distance it never measured', async () => {
    carrier();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ amount: 3250, currency: 'NGN' }) });
    const result = await quote(config({ mode: 'CARRIER', carrierProvider: 'http_carrier' }));
    expect(result.distance.basis).toBe('NONE');
    expect(result.distance.kilometres).toBeNull();
  });

  it('refuses a quote in the wrong currency rather than converting it', async () => {
    carrier();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ amount: 20, currency: 'USD' }) });
    const result = await quote(config({ mode: 'CARRIER', carrierProvider: 'http_carrier' }));
    expect(result.outcome).toBe('CARRIER_UNAVAILABLE');
    expect(result.message).toContain('USD');
    expect(result.fee.total).toBe(0);
  });

  it('falls back to a manual quote when the courier is down, if configured to', async () => {
    carrier();
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const result = await quote(
      config({ mode: 'CARRIER', carrierProvider: 'http_carrier', unsupportedDestination: 'MANUAL_QUOTE' }),
    );
    expect(result.outcome).toBe('MANUAL_QUOTE');
    expect(result.fee.total).toBe(0);
  });

  it('says so plainly when the courier is down and there is no fallback', async () => {
    carrier();
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const result = await quote(config({ mode: 'CARRIER', carrierProvider: 'http_carrier' }));
    expect(result.outcome).toBe('CARRIER_UNAVAILABLE');
    expect(result.priced).toBe(false);
  });

  it('refuses a dispatch-only integration, which cannot price anything', async () => {
    carrier({ capabilities: ['dispatch', 'tracking'] });
    const result = await quote(config({ mode: 'CARRIER', carrierProvider: 'http_carrier' }));
    expect(result.outcome).toBe('CARRIER_UNAVAILABLE');
    expect(result.message).toContain('does not quote prices');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says so when the chosen courier is no longer offered', async () => {
    setDeliveryServices([]);
    const result = await quote(config({ mode: 'CARRIER', carrierProvider: 'http_carrier' }));
    expect(result.outcome).toBe('CARRIER_UNAVAILABLE');
    expect(result.fee.total).toBe(0);
  });

  it('refuses to price an integration that has no adapter', async () => {
    setDeliveryServices([
      {
        provider: 'dhl', label: 'DHL', capabilities: ['rate_quote'], countries: [], baseUrl: null,
        apiKey: 'k', options: {}, allowBusinessCredentials: true, allowPlatformCredentials: true,
        businessSelectable: true, supportsBusinessCredentials: true,
      },
    ]);
    const result = await quote(config({ mode: 'CARRIER', carrierProvider: 'dhl' }));
    expect(result.outcome).toBe('CARRIER_UNAVAILABLE');
    expect(result.message).toContain('not available yet');
  });
});

describe('mode E — collection only', () => {
  it('needs no carrier and no maps provider', async () => {
    const cfg = config();
    cfg.delivery.enabled = false;
    const result = await quote(cfg);
    expect(result.outcome).toBe('DELIVERY_DISABLED');
    // Nothing was asked of any provider to reach that answer.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deliveryServiceByProvider('pickup')).not.toBeNull();
  });
});
