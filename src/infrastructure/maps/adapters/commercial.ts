import { providerFetch, trimBase, countryBias } from '../http';
import {
  isUsableCoordinate,
  ProviderError,
  type AddressSuggestion,
  type MapsAdapter,
  type Precision,
  type PlaceDetails,
  type RouteResult,
  type StructuredAddress,
} from '../types';

/**
 * The metered providers: Geoapify, GraphHopper, Mapbox and Google.
 *
 * All four answer the same questions; they differ in how they spell the
 * answers and in what they charge. Keeping them together makes the differences
 * visible — which is useful, because the differences are mostly in what each
 * one *will not* tell you without a second, separately billed call.
 */

/* ──────────────────────────── Geoapify ──────────────────────────── */

function geoapifyFeature(feature: Record<string, unknown>): AddressSuggestion | null {
  const p = (feature.properties ?? {}) as Record<string, unknown>;
  const formatted = String(p.formatted ?? '');
  if (!formatted) return null;
  const line1 = [p.housenumber, p.street].filter(Boolean).join(' ');
  const rank = (p.rank ?? {}) as Record<string, unknown>;
  const precision: Precision =
    p.housenumber ? 'rooftop' : p.street ? 'street' : p.city ? 'locality' : String(rank.match_type ?? '') ? 'locality' : 'unknown';
  return {
    placeId: p.place_id ? String(p.place_id) : null,
    formatted,
    address: {
      line1: line1 || (p.address_line1 as string) || undefined,
      line2: (p.suburb as string) || (p.district as string) || undefined,
      city: (p.city as string) ?? (p.town as string) ?? (p.village as string) ?? undefined,
      state: (p.state as string) || undefined,
      postalCode: (p.postcode as string) || undefined,
      country: p.country_code ? String(p.country_code).toUpperCase() : undefined,
    },
    coordinates: isUsableCoordinate(p.lat, p.lon)
      ? { latitude: Number(p.lat), longitude: Number(p.lon) }
      : null,
    precision,
  };
}

export const geoapifyAdapter: MapsAdapter = {
  id: 'geoapify',
  capabilities: ['autocomplete', 'place_details', 'geocode', 'reverse_geocode', 'route_distance'],

  async autocomplete(runtime, query, near) {
    const params = new URLSearchParams({ text: query, limit: '6', format: 'geojson' });
    params.set('apiKey', runtime.apiKey ?? '');
    const codes = countryBias(runtime.options);
    if (codes.length) params.set('filter', `countrycode:${codes.join(',')}`);
    if (near) params.set('bias', `proximity:${near.longitude},${near.latitude}`);
    const language = String(runtime.options.language ?? '').trim();
    if (language) params.set('lang', language);
    const body = (await providerFetch(
      runtime,
      `${trimBase(runtime.baseUrl)}/v1/geocode/autocomplete?${params}`,
    )) as Record<string, unknown>;
    const features = (body?.features ?? []) as Record<string, unknown>[];
    return features.map(geoapifyFeature).filter((s): s is AddressSuggestion => s !== null);
  },

  async placeDetails(runtime, placeId) {
    const params = new URLSearchParams({ id: placeId, apiKey: runtime.apiKey ?? '' });
    const body = (await providerFetch(
      runtime,
      `${trimBase(runtime.baseUrl)}/v2/place-details?${params}`,
    )) as Record<string, unknown>;
    const features = (body?.features ?? []) as Record<string, unknown>[];
    return features[0] ? geoapifyFeature(features[0]) : null;
  },

  async geocode(runtime, address) {
    const params = new URLSearchParams({ text: address, limit: '1', format: 'geojson' });
    params.set('apiKey', runtime.apiKey ?? '');
    const body = (await providerFetch(
      runtime,
      `${trimBase(runtime.baseUrl)}/v1/geocode/search?${params}`,
    )) as Record<string, unknown>;
    const features = (body?.features ?? []) as Record<string, unknown>[];
    return features[0] ? geoapifyFeature(features[0]) : null;
  },

  async reverseGeocode(runtime, point) {
    const params = new URLSearchParams({
      lat: String(point.latitude),
      lon: String(point.longitude),
      format: 'geojson',
      apiKey: runtime.apiKey ?? '',
    });
    const body = (await providerFetch(
      runtime,
      `${trimBase(runtime.baseUrl)}/v1/geocode/reverse?${params}`,
    )) as Record<string, unknown>;
    const features = (body?.features ?? []) as Record<string, unknown>[];
    return features[0] ? geoapifyFeature(features[0]) : null;
  },

  async routeDistance(runtime, from, to): Promise<RouteResult | null> {
    const params = new URLSearchParams({
      waypoints: `${from.latitude},${from.longitude}|${to.latitude},${to.longitude}`,
      mode: String(runtime.options.mode ?? 'drive'),
      apiKey: runtime.apiKey ?? '',
    });
    const body = (await providerFetch(runtime, `${trimBase(runtime.baseUrl)}/v1/routing?${params}`)) as Record<string, unknown>;
    const feature = ((body?.features ?? []) as Record<string, unknown>[])[0];
    const props = (feature?.properties ?? {}) as Record<string, unknown>;
    const metres = Number(props.distance);
    if (!Number.isFinite(metres)) return null;
    const seconds = Number(props.time);
    return {
      kilometres: Math.round((metres / 1000) * 100) / 100,
      seconds: Number.isFinite(seconds) ? Math.round(seconds) : null,
      basis: 'ROUTE',
    };
  },
};

/* ─────────────────────────── GraphHopper ─────────────────────────── */

function graphhopperHit(hit: Record<string, unknown>): AddressSuggestion | null {
  const point = (hit.point ?? {}) as Record<string, unknown>;
  const line1 = [hit.housenumber, hit.street ?? hit.name].filter(Boolean).join(' ');
  const formatted = [line1 || hit.name, hit.city, hit.state, hit.postcode, hit.country]
    .filter(Boolean)
    .join(', ');
  if (!formatted) return null;
  return {
    placeId: hit.osm_id ? String(hit.osm_id) : null,
    formatted,
    address: {
      line1: (line1 || (hit.name as string)) || undefined,
      city: (hit.city as string) || undefined,
      state: (hit.state as string) || undefined,
      postalCode: (hit.postcode as string) || undefined,
      country: hit.countrycode ? String(hit.countrycode).toUpperCase() : undefined,
    },
    coordinates: isUsableCoordinate(point.lat, point.lng)
      ? { latitude: Number(point.lat), longitude: Number(point.lng) }
      : null,
    precision: hit.housenumber ? 'rooftop' : hit.street ? 'street' : 'locality',
  };
}

export const graphhopperAdapter: MapsAdapter = {
  id: 'graphhopper',
  capabilities: ['route_distance', 'geocode', 'autocomplete'],

  async autocomplete(runtime, query) {
    const params = new URLSearchParams({ q: query, limit: '6', key: runtime.apiKey ?? '' });
    const locale = String(runtime.options.locale ?? '').trim();
    if (locale) params.set('locale', locale);
    const body = (await providerFetch(runtime, `${trimBase(runtime.baseUrl)}/geocode?${params}`)) as Record<string, unknown>;
    const hits = (body?.hits ?? []) as Record<string, unknown>[];
    return hits.map(graphhopperHit).filter((s): s is AddressSuggestion => s !== null);
  },

  async geocode(runtime, address) {
    const results = await graphhopperAdapter.autocomplete!(runtime, address);
    return results.find((r) => r.coordinates) ?? null;
  },

  async routeDistance(runtime, from, to): Promise<RouteResult | null> {
    const params = new URLSearchParams({
      profile: String(runtime.options.profile ?? 'car'),
      calc_points: 'false',
      key: runtime.apiKey ?? '',
    });
    params.append('point', `${from.latitude},${from.longitude}`);
    params.append('point', `${to.latitude},${to.longitude}`);
    const body = (await providerFetch(runtime, `${trimBase(runtime.baseUrl)}/route?${params}`)) as Record<string, unknown>;
    const path = ((body?.paths ?? []) as Record<string, unknown>[])[0];
    const metres = Number(path?.distance);
    if (!Number.isFinite(metres)) return null;
    const ms = Number(path?.time);
    return {
      kilometres: Math.round((metres / 1000) * 100) / 100,
      seconds: Number.isFinite(ms) ? Math.round(ms / 1000) : null,
      basis: 'ROUTE',
    };
  },
};

/* ───────────────────────────── Mapbox ───────────────────────────── */

function mapboxContext(feature: Record<string, unknown>): StructuredAddress {
  const context = (feature.context ?? []) as Record<string, string>[];
  const pick = (prefix: string) => context.find((c) => String(c.id ?? '').startsWith(prefix))?.text;
  const number = feature.address ? `${feature.address} ` : '';
  return {
    line1: `${number}${String(feature.text ?? '')}`.trim() || undefined,
    line2: pick('neighborhood'),
    city: pick('place') ?? pick('locality'),
    state: pick('region'),
    postalCode: pick('postcode'),
    country: context.find((c) => String(c.id ?? '').startsWith('country'))?.short_code?.toUpperCase(),
  };
}

function mapboxFeature(feature: Record<string, unknown>): AddressSuggestion | null {
  const center = (feature.center ?? []) as number[];
  const formatted = String(feature.place_name ?? '');
  if (!formatted) return null;
  const types = (feature.place_type ?? []) as string[];
  return {
    placeId: feature.id ? String(feature.id) : null,
    formatted,
    address: mapboxContext(feature),
    coordinates: isUsableCoordinate(center[1], center[0])
      ? { latitude: Number(center[1]), longitude: Number(center[0]) }
      : null,
    precision: types.includes('address')
      ? 'rooftop'
      : types.includes('street')
        ? 'street'
        : types.includes('place') || types.includes('locality')
          ? 'locality'
          : 'unknown',
  };
}

export const mapboxAdapter: MapsAdapter = {
  id: 'mapbox',
  capabilities: ['autocomplete', 'place_details', 'geocode', 'reverse_geocode', 'route_distance', 'map_tiles'],

  async autocomplete(runtime, query, near) {
    const params = new URLSearchParams({ access_token: runtime.apiKey ?? '', limit: '6', autocomplete: 'true' });
    const codes = countryBias(runtime.options);
    if (codes.length) params.set('country', codes.join(','));
    if (near) params.set('proximity', `${near.longitude},${near.latitude}`);
    const body = (await providerFetch(
      runtime,
      `${trimBase(runtime.baseUrl)}/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params}`,
    )) as Record<string, unknown>;
    const features = (body?.features ?? []) as Record<string, unknown>[];
    return features.map(mapboxFeature).filter((s): s is AddressSuggestion => s !== null);
  },

  /**
   * Mapbox has no separate details endpoint for a geocoding result: the
   * suggestion already carries the point and the context, so re-querying it by
   * its display name is the documented way to resolve one.
   */
  async placeDetails(runtime, placeId): Promise<PlaceDetails | null> {
    const results = await mapboxAdapter.autocomplete!(runtime, placeId);
    return results[0] ?? null;
  },

  async geocode(runtime, address) {
    const results = await mapboxAdapter.autocomplete!(runtime, address);
    return results.find((r) => r.coordinates) ?? null;
  },

  async reverseGeocode(runtime, point) {
    const params = new URLSearchParams({ access_token: runtime.apiKey ?? '', limit: '1' });
    const body = (await providerFetch(
      runtime,
      `${trimBase(runtime.baseUrl)}/geocoding/v5/mapbox.places/${point.longitude},${point.latitude}.json?${params}`,
    )) as Record<string, unknown>;
    const features = (body?.features ?? []) as Record<string, unknown>[];
    return features[0] ? mapboxFeature(features[0]) : null;
  },

  async routeDistance(runtime, from, to): Promise<RouteResult | null> {
    const profile = String(runtime.options.profile ?? 'mapbox/driving');
    const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    const params = new URLSearchParams({ access_token: runtime.apiKey ?? '', overview: 'false' });
    const body = (await providerFetch(
      runtime,
      `${trimBase(runtime.baseUrl)}/directions/v5/${profile}/${coords}?${params}`,
    )) as Record<string, unknown>;
    const route = ((body?.routes ?? []) as Record<string, unknown>[])[0];
    const metres = Number(route?.distance);
    if (!Number.isFinite(metres)) return null;
    const seconds = Number(route?.duration);
    return {
      kilometres: Math.round((metres / 1000) * 100) / 100,
      seconds: Number.isFinite(seconds) ? Math.round(seconds) : null,
      basis: 'ROUTE',
    };
  },
};

/* ───────────────────────────── Google ───────────────────────────── */

/**
 * Google answers 200 with a `status` field, so the HTTP code proves nothing.
 * Translating those statuses here is what lets the registry tell a dead key
 * from an address that simply does not exist.
 */
function assertGoogleOk(body: Record<string, unknown>, provider: string): void {
  const status = String(body?.status ?? '');
  if (status === 'OK' || status === 'ZERO_RESULTS') return;
  if (status === 'REQUEST_DENIED') {
    throw new ProviderError(`${provider} denied the request — check the key and its API restrictions`, 'auth', false);
  }
  if (status === 'OVER_QUERY_LIMIT' || status === 'OVER_DAILY_LIMIT') {
    throw new ProviderError(`${provider} is over its usage limit`, 'quota', true);
  }
  throw new ProviderError(`${provider} returned status ${status}`, 'bad_response', false);
}

const GOOGLE_COMPONENT: Record<string, keyof StructuredAddress> = {
  street_number: 'line1',
  route: 'line1',
  sublocality: 'line2',
  neighborhood: 'line2',
  locality: 'city',
  postal_town: 'city',
  administrative_area_level_1: 'state',
  postal_code: 'postalCode',
  country: 'country',
};

function googleAddress(components: Record<string, unknown>[]): StructuredAddress {
  const out: StructuredAddress = {};
  let streetNumber = '';
  let route = '';
  for (const component of components) {
    const types = (component.types ?? []) as string[];
    for (const type of types) {
      const field = GOOGLE_COMPONENT[type];
      if (!field) continue;
      const value = type === 'country' ? String(component.short_name ?? '') : String(component.long_name ?? '');
      if (type === 'street_number') streetNumber = value;
      else if (type === 'route') route = value;
      else if (!out[field]) out[field] = value;
    }
  }
  const line1 = [streetNumber, route].filter(Boolean).join(' ');
  if (line1) out.line1 = line1;
  if (out.country) out.country = out.country.toUpperCase();
  return out;
}

function googlePrecision(locationType: string, types: string[]): Precision {
  if (locationType === 'ROOFTOP' || types.includes('street_address')) return 'rooftop';
  if (locationType === 'RANGE_INTERPOLATED' || types.includes('route')) return 'street';
  if (types.includes('locality')) return 'locality';
  if (types.includes('administrative_area_level_1')) return 'region';
  if (types.includes('country')) return 'country';
  return 'unknown';
}

function googleResult(result: Record<string, unknown>): PlaceDetails | null {
  const geometry = (result.geometry ?? {}) as Record<string, unknown>;
  const location = (geometry.location ?? {}) as Record<string, unknown>;
  if (!isUsableCoordinate(location.lat, location.lng)) return null;
  return {
    placeId: result.place_id ? String(result.place_id) : null,
    formatted: String(result.formatted_address ?? ''),
    address: googleAddress((result.address_components ?? []) as Record<string, unknown>[]),
    coordinates: { latitude: Number(location.lat), longitude: Number(location.lng) },
    precision: googlePrecision(String(geometry.location_type ?? ''), (result.types ?? []) as string[]),
  };
}

export const googleAdapter: MapsAdapter = {
  id: 'google',
  capabilities: ['autocomplete', 'place_details', 'geocode', 'reverse_geocode', 'route_distance', 'map_tiles'],

  /**
   * Places autocomplete returns names and ids, never coordinates.
   *
   * That is not an oversight on Google's part — the details lookup is a
   * separate, separately billed call — so suggestions come back with a null
   * point and the caller asks for details once the customer has chosen.
   */
  async autocomplete(runtime, query, near) {
    const params = new URLSearchParams({ input: query, key: runtime.apiKey ?? '', types: 'address' });
    const codes = countryBias(runtime.options);
    if (codes.length) params.set('components', codes.map((c) => `country:${c}`).join('|'));
    if (near) params.set('location', `${near.latitude},${near.longitude}`);
    if (near) params.set('radius', '50000');
    const body = (await providerFetch(
      runtime,
      `${trimBase(runtime.baseUrl)}/maps/api/place/autocomplete/json?${params}`,
    )) as Record<string, unknown>;
    assertGoogleOk(body, 'Google Maps');
    const predictions = (body.predictions ?? []) as Record<string, unknown>[];
    return predictions.map((p) => ({
      placeId: p.place_id ? String(p.place_id) : null,
      formatted: String(p.description ?? ''),
      address: {},
      coordinates: null,
      precision: 'unknown' as Precision,
    }));
  },

  async placeDetails(runtime, placeId) {
    const params = new URLSearchParams({
      place_id: placeId,
      key: runtime.apiKey ?? '',
      fields: 'place_id,formatted_address,address_component,geometry',
    });
    const body = (await providerFetch(
      runtime,
      `${trimBase(runtime.baseUrl)}/maps/api/place/details/json?${params}`,
    )) as Record<string, unknown>;
    assertGoogleOk(body, 'Google Maps');
    const result = body.result as Record<string, unknown> | undefined;
    return result ? googleResult(result) : null;
  },

  async geocode(runtime, address) {
    const params = new URLSearchParams({ address, key: runtime.apiKey ?? '' });
    const codes = countryBias(runtime.options);
    if (codes.length) params.set('components', codes.map((c) => `country:${c}`).join('|'));
    const body = (await providerFetch(
      runtime,
      `${trimBase(runtime.baseUrl)}/maps/api/geocode/json?${params}`,
    )) as Record<string, unknown>;
    assertGoogleOk(body, 'Google Maps');
    const results = (body.results ?? []) as Record<string, unknown>[];
    return results[0] ? googleResult(results[0]) : null;
  },

  async reverseGeocode(runtime, point) {
    const params = new URLSearchParams({
      latlng: `${point.latitude},${point.longitude}`,
      key: runtime.apiKey ?? '',
    });
    const body = (await providerFetch(
      runtime,
      `${trimBase(runtime.baseUrl)}/maps/api/geocode/json?${params}`,
    )) as Record<string, unknown>;
    assertGoogleOk(body, 'Google Maps');
    const results = (body.results ?? []) as Record<string, unknown>[];
    return results[0] ? googleResult(results[0]) : null;
  },

  async routeDistance(runtime, from, to): Promise<RouteResult | null> {
    const params = new URLSearchParams({
      origins: `${from.latitude},${from.longitude}`,
      destinations: `${to.latitude},${to.longitude}`,
      units: 'metric',
      key: runtime.apiKey ?? '',
    });
    const body = (await providerFetch(
      runtime,
      `${trimBase(runtime.baseUrl)}/maps/api/distancematrix/json?${params}`,
    )) as Record<string, unknown>;
    assertGoogleOk(body, 'Google Maps');
    const rows = (body.rows ?? []) as Record<string, unknown>[];
    const element = ((rows[0]?.elements ?? []) as Record<string, unknown>[])[0];
    if (!element || String(element.status ?? '') !== 'OK') return null;
    const metres = Number((element.distance as Record<string, unknown> | undefined)?.value);
    if (!Number.isFinite(metres)) return null;
    const seconds = Number((element.duration as Record<string, unknown> | undefined)?.value);
    return {
      kilometres: Math.round((metres / 1000) * 100) / 100,
      seconds: Number.isFinite(seconds) ? Math.round(seconds) : null,
      basis: 'ROUTE',
    };
  },
};
