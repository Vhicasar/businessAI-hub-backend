import { describe, expect, it } from 'vitest';
import {
  quoteDelivery,
  quoteIsFresh,
  destinationIsComplete,
  pickupFee,
} from '../../src/application/delivery/delivery-pricing.service';
import {
  fulfilmentSettingsSchema,
  resolveOrigin,
  type FulfilmentConfig,
} from '../../src/application/delivery/fulfilment-settings.service';
import { haversineKm, isUsableCoordinate } from '../../src/application/delivery/geo.service';

/**
 * The fee a customer is quoted.
 *
 * Every case here passes its own configuration in, so the arithmetic is tested
 * rather than whatever a particular business happens to have saved. The items
 * list is empty in most of them: weight needs the catalogue, and the
 * end-to-end script covers that against a real one.
 */

const LAGOS = { latitude: 6.5244, longitude: 3.3792 };
const IKEJA = { latitude: 6.6018, longitude: 3.3515 };

function config(overrides: Record<string, unknown> = {}): FulfilmentConfig {
  const parsed = fulfilmentSettingsSchema.parse({
    pickup: {
      enabled: true,
      locationName: 'Main store',
      address: { line1: '1 Market Road', city: 'Lagos', country: 'NG' },
      coordinates: LAGOS,
      fee: 0,
    },
    delivery: {
      enabled: true,
      originSameAsPickup: true,
      pricing: { baseFee: 500, perKm: 100, perKg: 0, minFee: 0, maxFee: null, maxDistanceKm: null, freeOverSubtotal: null },
      ...((overrides.delivery as Record<string, unknown>) ?? {}),
    },
    ...(overrides.pickup ? { pickup: overrides.pickup } : {}),
  });
  return {
    ...parsed,
    currency: 'NGN',
    mapsConfigured: false,
    businessAddress: { line1: '', line2: '', city: '', state: '', country: '', postalCode: '' },
    businessCoordinates: { latitude: null, longitude: null },
  };
}

const destination = {
  address: { line1: '12 Allen Avenue', line2: '', city: 'Ikeja', state: 'Lagos', country: 'NG', postalCode: '' },
  latitude: IKEJA.latitude,
  longitude: IKEJA.longitude,
};

const quote = (cfg: FulfilmentConfig, extra: Record<string, unknown> = {}) =>
  quoteDelivery({ organizationId: 'org-test', items: [], destination, config: cfg, ...extra });

describe('delivery pricing', () => {
  it('adds the base fee to a distance charge', async () => {
    const result = await quote(config());
    expect(result.outcome).toBe('OK');
    expect(result.distance.kilometres).toBeGreaterThan(8);
    expect(result.distance.kilometres).toBeLessThan(10);
    // No maps key in the test environment, so the honest answer is the
    // straight line — and it says so rather than claiming a road distance.
    expect(result.distance.basis).toBe('STRAIGHT_LINE');
    expect(result.fee.base).toBe(500);
    expect(result.fee.distance).toBeCloseTo(100 * (result.distance.kilometres as number), 1);
    expect(result.fee.total).toBeCloseTo(result.fee.base + result.fee.distance, 2);
  });

  it('charges a flat fee when no per-kilometre rate is set', async () => {
    const result = await quote(
      config({ delivery: { pricing: { baseFee: 1500, perKm: 0, perKg: 0 } } }),
    );
    expect(result.outcome).toBe('OK');
    expect(result.fee.total).toBe(1500);
    expect(result.fee.distance).toBe(0);
    // Nothing depends on distance, so nothing had to be looked up.
    expect(result.distance.basis).toBe('NONE');
  });

  it('never falls below the minimum fee', async () => {
    const result = await quote(
      config({ delivery: { pricing: { baseFee: 100, perKm: 0, perKg: 0, minFee: 800 } } }),
    );
    expect(result.fee.total).toBe(800);
    expect(result.fee.adjustment).toBe(700);
  });

  it('never exceeds the maximum fee', async () => {
    const result = await quote(
      config({ delivery: { pricing: { baseFee: 500, perKm: 1000, perKg: 0, maxFee: 2000 } } }),
    );
    expect(result.fee.total).toBe(2000);
    expect(result.fee.adjustment).toBeLessThan(0);
  });

  it('refuses a destination beyond the service radius', async () => {
    const result = await quote(
      config({ delivery: { pricing: { baseFee: 500, perKm: 100, maxDistanceKm: 2 } } }),
    );
    expect(result.outcome).toBe('OUT_OF_RANGE');
    expect(result.priced).toBe(false);
    expect(result.fee.total).toBe(0);
    expect(result.message).toContain('beyond');
  });

  it('routes an out-of-range destination to a manual quote when configured', async () => {
    const result = await quote(
      config({
        delivery: {
          pricing: { baseFee: 500, perKm: 100, maxDistanceKm: 2 },
          unsupportedDestination: 'MANUAL_QUOTE',
          manualQuoteMessage: 'We will call you about delivery.',
        },
      }),
    );
    expect(result.outcome).toBe('MANUAL_QUOTE');
    expect(result.priced).toBe(false);
    expect(result.message).toBe('We will call you about delivery.');
  });

  it('delivers free above the configured basket value, and charges below it', async () => {
    const cfg = config({
      delivery: { pricing: { baseFee: 1500, perKm: 0, perKg: 0, freeOverSubtotal: 20_000 } },
    });
    expect((await quote(cfg, { subtotal: 25_000 })).fee.total).toBe(0);
    expect((await quote(cfg, { subtotal: 19_999 })).fee.total).toBe(1500);
  });

  it('will not quote for a business that has delivery switched off', async () => {
    const cfg = config();
    cfg.delivery.enabled = false;
    const result = await quote(cfg);
    expect(result.outcome).toBe('DELIVERY_DISABLED');
    expect(result.fee.total).toBe(0);
  });

  it('asks for a complete address before pricing anything', async () => {
    const result = await quoteDelivery({
      organizationId: 'org-test',
      items: [],
      destination: { address: { line1: '', line2: '', city: '', state: '', country: '', postalCode: '' } },
      config: config(),
    });
    expect(result.outcome).toBe('UNRESOLVED_ADDRESS');
    expect(destinationIsComplete(destination.address)).toBe(true);
  });

  it('cannot price by distance when the business has no origin', async () => {
    const cfg = config();
    cfg.pickup.coordinates = { latitude: null, longitude: null };
    const result = await quote(cfg);
    expect(result.outcome).toBe('UNRESOLVED_ADDRESS');
    expect(result.message).toContain('delivers from');
  });

  it('charges the configured collection fee, which is usually nothing', () => {
    expect(pickupFee(config()).total).toBe(0);
    const paid = config();
    paid.pickup.fee = 250;
    expect(pickupFee(paid).total).toBe(250);
  });
});

describe('quote freshness', () => {
  it('accepts a quote that has not expired', () => {
    expect(quoteIsFresh({ expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(true);
  });

  it('rejects an expired one, and one with no expiry at all', () => {
    expect(quoteIsFresh({ expiresAt: new Date(Date.now() - 1).toISOString() })).toBe(false);
    expect(quoteIsFresh({ expiresAt: null })).toBe(false);
    expect(quoteIsFresh(null)).toBe(false);
  });
});

describe('coordinates', () => {
  it('treats null island as unusable, because a failed parse lands there', () => {
    expect(isUsableCoordinate(0, 0)).toBe(false);
    expect(isUsableCoordinate(6.5244, 3.3792)).toBe(true);
    expect(isUsableCoordinate('nonsense', 3)).toBe(false);
    expect(isUsableCoordinate(91, 3)).toBe(false);
  });

  it('measures the great circle', () => {
    expect(haversineKm(LAGOS, IKEJA)).toBeGreaterThan(8);
    expect(haversineKm(LAGOS, LAGOS)).toBe(0);
  });
});

describe('origin resolution', () => {
  it('uses the pickup address when deliveries leave from there', () => {
    const origin = resolveOrigin(config());
    expect(origin.address.city).toBe('Lagos');
    expect(origin.latitude).toBe(LAGOS.latitude);
  });

  it('falls back to the business address when nothing else is set', () => {
    const cfg = config();
    cfg.pickup.address = { line1: '', line2: '', city: '', state: '', country: '', postalCode: '' };
    cfg.businessAddress = { line1: '9 Broad Street', line2: '', city: 'Lagos', state: '', country: 'NG', postalCode: '' };
    expect(resolveOrigin(cfg).address.line1).toBe('9 Broad Street');
  });
});
