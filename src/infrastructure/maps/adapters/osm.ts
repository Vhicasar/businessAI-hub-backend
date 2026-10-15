import { providerFetch, trimBase, countryBias } from '../http';
import {
  isUsableCoordinate,
  type AddressSuggestion,
  type MapsAdapter,
  type Precision,
  type ProviderRuntime,
  type RouteResult,
  type StructuredAddress,
} from '../types';

/**
 * The OpenStreetMap family: Nominatim, Photon and OSRM.
 *
 * Grouped because they share one data set and one attribution, and differ only
 * in what they are good at — Nominatim searches addresses, Photon does it fast
 * enough to type into, OSRM routes between points. All three are self-hostable,
 * which is the point of them: a business can have address search and distance
 * pricing without sending its customers' addresses to a vendor or paying per
 * keystroke.
 */

/** Nominatim's `address` object, in the shape a form wants. */
function nominatimAddress(raw: Record<string, unknown>): StructuredAddress {
  const a = (raw.address ?? {}) as Record<string, string>;
  const road = a.road ?? a.pedestrian ?? a.footway ?? '';
  return {
    line1: [a.house_number ?? '', road].filter(Boolean).join(' ') || undefined,
    line2: a.suburb ?? a.neighbourhood ?? undefined,
    city: a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? undefined,
    state: a.state ?? a.region ?? undefined,
    postalCode: a.postcode ?? undefined,
    country: a.country_code ? a.country_code.toUpperCase() : undefined,
  };
}

/** How specific a result is, from whatever the provider was willing to say. */
function nominatimPrecision(raw: Record<string, unknown>): Precision {
  const cls = String(raw.class ?? '');
  const type = String(raw.type ?? '');
  const address = (raw.address ?? {}) as Record<string, string>;
  if (cls === 'building' || type === 'house' || address.house_number) return 'rooftop';
  if (cls === 'highway') return 'street';
  if (['city', 'town', 'village', 'suburb'].includes(type)) return 'locality';
  if (['state', 'region', 'county'].includes(type)) return 'region';
  if (type === 'country') return 'country';
  return 'unknown';
}

async function nominatimSearch(
  runtime: ProviderRuntime,
  query: string,
  limit: number,
): Promise<AddressSuggestion[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    addressdetails: '1',
    limit: String(limit),
  });
  // Nominatim's usage policy requires a contact address on every request.
  const email = String(runtime.options.email ?? '').trim();
  if (email) params.set('email', email);
  const codes = countryBias(runtime.options);
  if (codes.length) params.set('countrycodes', codes.join(','));

  const body = (await providerFetch(runtime, `${trimBase(runtime.baseUrl)}/search?${params}`)) as unknown;
  if (!Array.isArray(body)) return [];
  return body
    .map((entry) => entry as Record<string, unknown>)
    .filter((row) => isUsableCoordinate(row.lat, row.lon))
    .map((row) => ({
      placeId: row.place_id ? String(row.place_id) : null,
      formatted: String(row.display_name ?? ''),
      address: nominatimAddress(row),
      coordinates: { latitude: Number(row.lat), longitude: Number(row.lon) },
      precision: nominatimPrecision(row),
    }));
}

export const nominatimAdapter: MapsAdapter = {
  id: 'nominatim',
  capabilities: ['geocode', 'reverse_geocode', 'autocomplete'],

  async autocomplete(runtime, query) {
    return nominatimSearch(runtime, query, 6);
  },

  async geocode(runtime, address) {
    const [first] = await nominatimSearch(runtime, address, 1);
    return first ?? null;
  },

  async reverseGeocode(runtime, point) {
    const params = new URLSearchParams({
      lat: String(point.latitude),
      lon: String(point.longitude),
      format: 'jsonv2',
      addressdetails: '1',
    });
    const email = String(runtime.options.email ?? '').trim();
    if (email) params.set('email', email);
    const body = (await providerFetch(
      runtime,
      `${trimBase(runtime.baseUrl)}/reverse?${params}`,
    )) as Record<string, unknown>;
    if (!body || !isUsableCoordinate(body.lat, body.lon)) return null;
    return {
      placeId: body.place_id ? String(body.place_id) : null,
      formatted: String(body.display_name ?? ''),
      address: nominatimAddress(body),
      coordinates: { latitude: Number(body.lat), longitude: Number(body.lon) },
      precision: nominatimPrecision(body),
    };
  },
};

/* ───────────────────────────── Photon ───────────────────────────── */

function photonFeature(feature: Record<string, unknown>): AddressSuggestion | null {
  const props = (feature.properties ?? {}) as Record<string, string>;
  const geometry = (feature.geometry ?? {}) as { coordinates?: number[] };
  const [lon, lat] = geometry.coordinates ?? [];
  const line1 = [props.housenumber, props.street ?? props.name].filter(Boolean).join(' ');
  const formatted = [line1 || props.name, props.district, props.city, props.state, props.postcode, props.country]
    .filter(Boolean)
    .join(', ');
  if (!formatted) return null;
  return {
    placeId: props.osm_id ? `${props.osm_type ?? 'N'}${props.osm_id}` : null,
    formatted,
    address: {
      line1: line1 || props.name || undefined,
      line2: props.district || undefined,
      city: props.city ?? props.town ?? props.village ?? undefined,
      state: props.state || undefined,
      postalCode: props.postcode || undefined,
      country: props.countrycode ? props.countrycode.toUpperCase() : undefined,
    },
    // Photon returns a point with every hit, which is what makes it usable for
    // type-ahead: the fee can be worked out from the selection directly.
    coordinates: isUsableCoordinate(lat, lon) ? { latitude: Number(lat), longitude: Number(lon) } : null,
    precision: props.housenumber ? 'rooftop' : props.street ? 'street' : 'locality',
  };
}

export const photonAdapter: MapsAdapter = {
  id: 'photon',
  capabilities: ['autocomplete', 'geocode', 'reverse_geocode'],

  async autocomplete(runtime, query, near) {
    const params = new URLSearchParams({ q: query, limit: '6' });
    const language = String(runtime.options.language ?? '').trim();
    if (language) params.set('lang', language);
    // Biasing to where the business is makes the first suggestion the right
    // one far more often than any amount of extra typing.
    if (near) {
      params.set('lat', String(near.latitude));
      params.set('lon', String(near.longitude));
    }
    const body = (await providerFetch(runtime, `${trimBase(runtime.baseUrl)}/api?${params}`)) as Record<string, unknown>;
    const features = (body?.features ?? []) as Record<string, unknown>[];
    return features.map(photonFeature).filter((s): s is AddressSuggestion => s !== null);
  },

  async geocode(runtime, address) {
    const results = await photonAdapter.autocomplete!(runtime, address);
    return results.find((r) => r.coordinates) ?? null;
  },

  async reverseGeocode(runtime, point) {
    const params = new URLSearchParams({ lat: String(point.latitude), lon: String(point.longitude) });
    const body = (await providerFetch(runtime, `${trimBase(runtime.baseUrl)}/reverse?${params}`)) as Record<string, unknown>;
    const features = (body?.features ?? []) as Record<string, unknown>[];
    return features[0] ? photonFeature(features[0]) : null;
  },
};

/* ────────────────────────────── OSRM ────────────────────────────── */

export const osrmAdapter: MapsAdapter = {
  id: 'osrm',
  capabilities: ['route_distance'],

  async routeDistance(runtime, from, to): Promise<RouteResult | null> {
    const profile = String(runtime.options.profile ?? 'driving');
    const path = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    const body = (await providerFetch(
      runtime,
      `${trimBase(runtime.baseUrl)}/route/v1/${profile}/${path}?overview=false`,
    )) as Record<string, unknown>;
    if (String(body?.code) !== 'Ok') return null;
    const route = ((body.routes ?? []) as Record<string, unknown>[])[0];
    const metres = Number(route?.distance);
    if (!Number.isFinite(metres)) return null;
    const duration = Number(route?.duration);
    return {
      kilometres: Math.round((metres / 1000) * 100) / 100,
      seconds: Number.isFinite(duration) ? Math.round(duration) : null,
      basis: 'ROUTE',
    };
  },
};
