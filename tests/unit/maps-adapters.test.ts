import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nominatimAdapter, photonAdapter, osrmAdapter } from '../../src/infrastructure/maps/adapters/osm';
import { geoapifyAdapter, mapboxAdapter, googleAdapter } from '../../src/infrastructure/maps/adapters/commercial';
import { ProviderError, type ProviderRuntime } from '../../src/infrastructure/maps/types';

/**
 * Reading what each provider actually sends back.
 *
 * Responses are the real shapes from each provider's documentation, trimmed to
 * the fields the adapter reads. What is asserted is that four different
 * spellings of "12 Allen Avenue, Ikeja" come out of this layer looking the
 * same — which is the whole point of having it.
 */

const runtime = (provider: string, options: Record<string, unknown> = {}): ProviderRuntime => ({
  provider,
  baseUrl: 'https://example.test',
  apiKey: 'test-key',
  publicToken: null,
  options,
  timeoutMs: 1000,
  attribution: '',
});

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const respond = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

describe('Nominatim', () => {
  it('reads an address into structured parts', async () => {
    respond([
      {
        place_id: 123,
        lat: '6.6018',
        lon: '3.3515',
        display_name: '12, Allen Avenue, Ikeja, Lagos, Nigeria',
        class: 'building',
        type: 'house',
        address: {
          house_number: '12',
          road: 'Allen Avenue',
          city: 'Ikeja',
          state: 'Lagos',
          country_code: 'ng',
        },
      },
    ]);
    const [hit] = await nominatimAdapter.autocomplete!(runtime('nominatim'), 'allen avenue');
    expect(hit.address.line1).toBe('12 Allen Avenue');
    expect(hit.address.city).toBe('Ikeja');
    expect(hit.address.country).toBe('NG');
    expect(hit.coordinates).toEqual({ latitude: 6.6018, longitude: 3.3515 });
    expect(hit.precision).toBe('rooftop');
  });

  it('sends the contact address its usage policy requires', async () => {
    respond([]);
    await nominatimAdapter.geocode!(runtime('nominatim', { email: 'ops@example.test' }), 'lagos');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('email=ops%40example.test');
  });

  it('drops a result with no usable point rather than inventing one', async () => {
    respond([{ display_name: 'Somewhere', lat: '0', lon: '0' }]);
    expect(await nominatimAdapter.autocomplete!(runtime('nominatim'), 'somewhere')).toEqual([]);
  });
});

describe('Photon', () => {
  it('reads a GeoJSON feature, point included', async () => {
    respond({
      features: [
        {
          geometry: { coordinates: [3.3515, 6.6018] },
          properties: {
            osm_id: 42, osm_type: 'W', housenumber: '12', street: 'Allen Avenue',
            city: 'Ikeja', state: 'Lagos', countrycode: 'ng',
          },
        },
      ],
    });
    const [hit] = await photonAdapter.autocomplete!(runtime('photon'), 'allen');
    expect(hit.formatted).toContain('12 Allen Avenue');
    expect(hit.coordinates).toEqual({ latitude: 6.6018, longitude: 3.3515 });
    expect(hit.address.country).toBe('NG');
  });

  it('biases to where the business is when told where that is', async () => {
    respond({ features: [] });
    await photonAdapter.autocomplete!(runtime('photon'), 'allen', { latitude: 6.5, longitude: 3.3 });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('lat=6.5');
    expect(url).toContain('lon=3.3');
  });
});

describe('OSRM', () => {
  it('reads a route as kilometres and seconds', async () => {
    respond({ code: 'Ok', routes: [{ distance: 12_430, duration: 1_500 }] });
    const route = await osrmAdapter.routeDistance!(
      runtime('osrm'),
      { latitude: 6.5, longitude: 3.3 },
      { latitude: 6.6, longitude: 3.4 },
    );
    expect(route).toEqual({ kilometres: 12.43, seconds: 1500, basis: 'ROUTE' });
  });

  it('returns nothing when no route exists, rather than a straight line', async () => {
    respond({ code: 'NoRoute' });
    expect(
      await osrmAdapter.routeDistance!(runtime('osrm'), { latitude: 6.5, longitude: 3.3 }, { latitude: 51, longitude: 0 }),
    ).toBeNull();
  });
});

describe('Geoapify', () => {
  it('reads an autocomplete feature', async () => {
    respond({
      features: [
        {
          properties: {
            place_id: 'gp1', formatted: '12 Allen Avenue, Ikeja, Nigeria',
            housenumber: '12', street: 'Allen Avenue', city: 'Ikeja',
            state: 'Lagos', country_code: 'ng', lat: 6.6018, lon: 3.3515,
          },
        },
      ],
    });
    const [hit] = await geoapifyAdapter.autocomplete!(runtime('geoapify'), 'allen');
    expect(hit.placeId).toBe('gp1');
    expect(hit.address.line1).toBe('12 Allen Avenue');
    expect(hit.coordinates?.latitude).toBe(6.6018);
  });
});

describe('Mapbox', () => {
  it('reads context into the structured fields', async () => {
    respond({
      features: [
        {
          id: 'address.1',
          place_name: '12 Allen Avenue, Ikeja, Lagos, Nigeria',
          address: '12',
          text: 'Allen Avenue',
          center: [3.3515, 6.6018],
          place_type: ['address'],
          context: [
            { id: 'place.1', text: 'Ikeja' },
            { id: 'region.1', text: 'Lagos' },
            { id: 'country.1', text: 'Nigeria', short_code: 'ng' },
          ],
        },
      ],
    });
    const [hit] = await mapboxAdapter.autocomplete!(runtime('mapbox'), 'allen');
    expect(hit.address.line1).toBe('12 Allen Avenue');
    expect(hit.address.city).toBe('Ikeja');
    expect(hit.address.country).toBe('NG');
    expect(hit.precision).toBe('rooftop');
  });
});

describe('Google', () => {
  it('returns suggestions without coordinates, because Places does not give any', async () => {
    respond({ status: 'OK', predictions: [{ place_id: 'g1', description: '12 Allen Avenue, Ikeja' }] });
    const [hit] = await googleAdapter.autocomplete!(runtime('google'), 'allen');
    expect(hit.placeId).toBe('g1');
    // Nothing is guessed here. The details lookup is what resolves the point.
    expect(hit.coordinates).toBeNull();
    expect(hit.precision).toBe('unknown');
  });

  it('resolves a chosen place into a point and parts', async () => {
    respond({
      status: 'OK',
      result: {
        place_id: 'g1',
        formatted_address: '12 Allen Ave, Ikeja, Lagos, Nigeria',
        geometry: { location: { lat: 6.6018, lng: 3.3515 }, location_type: 'ROOFTOP' },
        address_components: [
          { long_name: '12', short_name: '12', types: ['street_number'] },
          { long_name: 'Allen Avenue', short_name: 'Allen Ave', types: ['route'] },
          { long_name: 'Ikeja', short_name: 'Ikeja', types: ['locality'] },
          { long_name: 'Lagos', short_name: 'LA', types: ['administrative_area_level_1'] },
          { long_name: 'Nigeria', short_name: 'NG', types: ['country'] },
        ],
      },
    });
    const details = await googleAdapter.placeDetails!(runtime('google'), 'g1');
    expect(details?.address).toMatchObject({ line1: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos', country: 'NG' });
    expect(details?.precision).toBe('rooftop');
  });

  it('tells a rejected key from an address that does not exist', async () => {
    // Google answers 200 with a status field, so the HTTP code proves nothing.
    respond({ status: 'REQUEST_DENIED', error_message: 'key invalid' });
    await expect(googleAdapter.geocode!(runtime('google'), 'lagos')).rejects.toBeInstanceOf(ProviderError);

    respond({ status: 'ZERO_RESULTS', results: [] });
    expect(await googleAdapter.geocode!(runtime('google'), 'nowhere at all')).toBeNull();
  });

  it('reports being over quota as something worth retrying', async () => {
    respond({ status: 'OVER_QUERY_LIMIT' });
    await expect(googleAdapter.geocode!(runtime('google'), 'lagos')).rejects.toMatchObject({
      kind: 'quota',
      retryable: true,
    });
  });
});

describe('transport failures', () => {
  it('turns an unauthorised response into a credentials error', async () => {
    respond({}, 401);
    await expect(photonAdapter.autocomplete!(runtime('photon'), 'allen')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('turns a 429 into something retryable', async () => {
    respond({}, 429);
    await expect(photonAdapter.autocomplete!(runtime('photon'), 'allen')).rejects.toMatchObject({
      kind: 'quota',
      retryable: true,
    });
  });
});
