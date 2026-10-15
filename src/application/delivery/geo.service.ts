import {
  geocodeAddress,
  distanceBetween as resolveDistance,
  geocodingAvailable,
  routingAvailable,
} from '../maps/maps.service';
import {
  haversineKm,
  isUsableCoordinate,
  type Coordinates,
  type DistanceBasis,
} from '../../infrastructure/maps/types';
import { clearMapsCache } from '../../infrastructure/maps/registry';

/**
 * Turning an address into a point, and two points into a distance.
 *
 * This used to be the whole implementation — one hardcoded vendor, one API key
 * in the environment, and its own small cache. It is now a façade over the
 * provider registry, kept because delivery pricing reads from it and the
 * distinction it draws is the one that matters to pricing: whether the
 * distance is a real route or an estimate.
 *
 * `ROUTE` is a driving distance. `STRAIGHT_LINE` is the great circle, which is
 * shorter than any road and is labelled an estimate wherever it is shown.
 * `NONE` means the distance is genuinely unknown, and the caller must not
 * pretend otherwise.
 */

export type { Coordinates, DistanceBasis };
export { haversineKm, isUsableCoordinate };

export interface GeocodeResult {
  coordinates: Coordinates | null;
  /** The provider's tidied-up version of the address, when it gave one. */
  formatted: string | null;
  /** Null on success; a human-readable reason otherwise. */
  error: string | null;
  /** Required wherever this result is displayed. */
  attribution: string;
}

export interface DistanceResult {
  kilometres: number | null;
  basis: DistanceBasis;
  error: string | null;
  attribution: string;
}

/**
 * Whether an address can be turned into a point at all.
 *
 * Asked by checkout to decide whether to promise a distance-based fee. A
 * deployment with a routing engine but no geocoder can still measure between
 * two known points and cannot look an address up, so the two are separate
 * questions and are answered separately.
 */
export function mapsConfigured(): boolean {
  return geocodingAvailable();
}

export function routeDistanceConfigured(): boolean {
  return routingAvailable();
}

export async function geocode(address: string): Promise<GeocodeResult> {
  const query = address.trim().replace(/\s+/g, ' ');
  if (!query) return { coordinates: null, formatted: null, error: 'No address to look up', attribution: '' };
  if (!geocodingAvailable()) {
    return {
      coordinates: null,
      formatted: null,
      error: 'No mapping provider is configured',
      attribution: '',
    };
  }

  const resolved = await geocodeAddress(query);
  if (!resolved.value?.coordinates) {
    return {
      coordinates: null,
      formatted: null,
      error: 'That address could not be found',
      attribution: resolved.attribution,
    };
  }
  return {
    coordinates: resolved.value.coordinates,
    formatted: resolved.value.formatted || null,
    error: null,
    attribution: resolved.attribution,
  };
}

export async function distanceBetween(from: Coordinates, to: Coordinates): Promise<DistanceResult> {
  const answer = await resolveDistance(from, to);
  return {
    kilometres: answer.kilometres,
    basis: answer.basis,
    error: null,
    attribution: answer.attribution,
  };
}

/** Visible for testing: drop everything the process has remembered. */
export function clearGeoCache(): void {
  clearMapsCache();
}
