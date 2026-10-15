import {
  serve,
  capabilityAvailable,
  mapsRuntime,
  NoProviderError,
  usageSnapshot,
} from '../../infrastructure/maps/registry';
import {
  haversineKm,
  isUsableCoordinate,
  type AddressSuggestion,
  type Coordinates,
  type DistanceBasis,
  type PlaceDetails,
  type StructuredAddress,
} from '../../infrastructure/maps/types';

/**
 * What the rest of the product asks of a map.
 *
 * Everything above this line is provider-specific; nothing below it is. A
 * feature asks for an address lookup and gets one, or gets a reason — it never
 * learns which vendor answered except to put the required attribution on the
 * screen.
 *
 * Two rules run through all of it. Nothing is ever invented: a lookup that
 * cannot be made returns null with a reason rather than a plausible-looking
 * coordinate. And nothing claims more confidence than it has: a suggestion the
 * customer picked off a list is *suggested*, and only becomes *verified* when
 * a provider has returned a point for it.
 */

export type { AddressSuggestion, PlaceDetails, Coordinates, StructuredAddress };

export interface Attributed<T> {
  value: T;
  provider: string | null;
  attribution: string;
}

export interface AutocompleteResult {
  suggestions: AddressSuggestion[];
  provider: string | null;
  attribution: string;
  /** Null when it worked; a sentence for the customer when it did not. */
  error: string | null;
}

function failure(err: unknown): string {
  if (err instanceof NoProviderError) {
    return mapsRuntime().providers.length === 0
      ? 'Address search is not set up on this workspace yet.'
      : 'Address search is temporarily unavailable. You can type the address instead.';
  }
  return 'Address search is temporarily unavailable. You can type the address instead.';
}

export function autocompleteAvailable(): boolean {
  return capabilityAvailable('autocomplete');
}

export function routingAvailable(): boolean {
  return capabilityAvailable('route_distance');
}

export function geocodingAvailable(): boolean {
  return capabilityAvailable('geocode');
}

/**
 * Suggestions for a partly-typed address.
 *
 * Short input is refused here rather than at the edge, so every caller gets
 * the same behaviour: two characters match half a country and cost a billable
 * request to prove it.
 */
export async function suggestAddresses(
  query: string,
  near?: Coordinates | null,
): Promise<AutocompleteResult> {
  const text = query.trim();
  if (text.length < 3) {
    return { suggestions: [], provider: null, attribution: '', error: null };
  }
  try {
    const served = await serve('autocomplete', `${text.toLowerCase()}|${near ? `${near.latitude.toFixed(2)},${near.longitude.toFixed(2)}` : ''}`, (adapter, runtime) =>
      adapter.autocomplete!(runtime, text, near ?? undefined),
    );
    return {
      suggestions: served.value,
      provider: served.provider,
      attribution: served.attribution,
      error: null,
    };
  } catch (err) {
    return { suggestions: [], provider: null, attribution: '', error: failure(err) };
  }
}

/**
 * Resolve a chosen suggestion to a point and structured parts.
 *
 * Needed because several providers — Google among them — hand back a name and
 * an id from autocomplete and nothing else. Taking the display text and
 * guessing where it is would be making up a delivery charge.
 */
export async function resolvePlace(placeId: string): Promise<Attributed<PlaceDetails | null>> {
  try {
    const served = await serve('place_details', placeId, (adapter, runtime) =>
      adapter.placeDetails!(runtime, placeId),
    );
    return { value: served.value, provider: served.provider, attribution: served.attribution };
  } catch {
    return { value: null, provider: null, attribution: '' };
  }
}

export async function geocodeAddress(address: string): Promise<Attributed<PlaceDetails | null>> {
  const text = address.trim();
  if (!text) return { value: null, provider: null, attribution: '' };
  try {
    const served = await serve('geocode', text.toLowerCase(), (adapter, runtime) =>
      adapter.geocode!(runtime, text),
    );
    return { value: served.value, provider: served.provider, attribution: served.attribution };
  } catch {
    return { value: null, provider: null, attribution: '' };
  }
}

export async function reverseGeocode(point: Coordinates): Promise<Attributed<PlaceDetails | null>> {
  if (!isUsableCoordinate(point.latitude, point.longitude)) {
    return { value: null, provider: null, attribution: '' };
  }
  try {
    const key = `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`;
    const served = await serve('reverse_geocode', key, (adapter, runtime) =>
      adapter.reverseGeocode!(runtime, point),
    );
    return { value: served.value, provider: served.provider, attribution: served.attribution };
  } catch {
    return { value: null, provider: null, attribution: '' };
  }
}

export interface DistanceAnswer {
  kilometres: number | null;
  basis: DistanceBasis;
  seconds: number | null;
  provider: string | null;
  attribution: string;
  /** Null when a real route was obtained; a reason when it was estimated. */
  note: string | null;
}

/**
 * How far apart two points are.
 *
 * Falls back to the great-circle distance when no routing provider answers,
 * and says so. That matters: a straight line is always shorter than the road,
 * so a fee computed from one under-charges, and a customer told "12.4 km" is
 * owed the difference between a measurement and an estimate.
 */
export async function distanceBetween(from: Coordinates, to: Coordinates): Promise<DistanceAnswer> {
  const straight = haversineKm(from, to);
  try {
    const served = await serve(
      'route_distance',
      `${from.latitude.toFixed(4)},${from.longitude.toFixed(4)}|${to.latitude.toFixed(4)},${to.longitude.toFixed(4)}`,
      (adapter, runtime) => adapter.routeDistance!(runtime, from, to),
    );
    if (served.value) {
      return {
        kilometres: served.value.kilometres,
        basis: served.value.basis,
        seconds: served.value.seconds,
        provider: served.provider,
        attribution: served.attribution,
        note: null,
      };
    }
  } catch {
    /* fall through to the estimate */
  }
  return {
    kilometres: straight,
    basis: 'STRAIGHT_LINE',
    seconds: null,
    provider: null,
    attribution: '',
    note: 'Estimated from the straight-line distance; no routing provider was available.',
  };
}

/** The browser token for drawing a map, if one is configured. */
export function mapDisplayConfig(): { provider: string; token: string; attribution: string } | null {
  const tiles = mapsRuntime().providers.find(
    (p) => p.capabilities.includes('map_tiles') && p.publicToken,
  );
  if (!tiles) return null;
  // Deliberately the *public* token and never the server key. The two are
  // different credentials with different restrictions, and conflating them is
  // how a server key ends up in browser JavaScript.
  return { provider: tiles.provider, token: tiles.publicToken!, attribution: tiles.attribution };
}

/** For the operations screens: who is configured and how much they are used. */
export function mapsHealth(): {
  providers: { provider: string; capabilities: string[]; hasKey: boolean; priority: number }[];
  capabilities: Record<string, string[]>;
  usage: { provider: string; thisMinute: number; thisMonth: number }[];
} {
  const runtime = mapsRuntime();
  return {
    providers: runtime.providers.map((p) => ({
      provider: p.provider,
      capabilities: p.capabilities,
      hasKey: Boolean(p.apiKey),
      priority: p.priority,
    })),
    capabilities: runtime.order,
    usage: usageSnapshot(),
  };
}
