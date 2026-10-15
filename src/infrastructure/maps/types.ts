/**
 * What the application asks of a map, independent of who draws it.
 *
 * Six capabilities, kept apart because providers differ: a routing engine has
 * no address search, a geocoder draws no tiles, and a provider that does five
 * of them may be entitled to only three on the plan the operator is paying
 * for. Anything that treats "a maps provider" as a single thing eventually
 * calls an endpoint that does not exist.
 */

export const MAPS_CAPABILITIES = [
  'autocomplete',
  'place_details',
  'geocode',
  'reverse_geocode',
  'route_distance',
  'map_tiles',
] as const;

export type MapsCapability = (typeof MAPS_CAPABILITIES)[number];

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/**
 * An address broken into the parts a form needs.
 *
 * Every field is optional because the world's addresses do not agree on which
 * parts exist. A Lagos address has no postal code worth collecting; a Japanese
 * one has no street name. The formatted line is the only thing always present.
 */
export interface StructuredAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  /** ISO-3166 alpha-2, upper case. */
  country?: string;
}

/**
 * How sure we are about a point.
 *
 * `rooftop` is a specific building; `street` is somewhere along the right road;
 * `locality` is the right town and nothing finer. Delivery pricing cares a
 * great deal about the difference, and so does a customer being charged by
 * the kilometre.
 */
export type Precision = 'rooftop' | 'street' | 'locality' | 'region' | 'country' | 'unknown';

export interface AddressSuggestion {
  /** The provider's own handle for this place, for a later details lookup. */
  placeId: string | null;
  /** One line, as the provider formats it — what the dropdown shows. */
  formatted: string;
  /** The parts, where the provider broke them out. */
  address: StructuredAddress;
  /**
   * Present only when the provider returned a point with the suggestion.
   *
   * Several do not, and inferring one from the display text would be making a
   * delivery charge up out of a string. Null means "ask for details".
   */
  coordinates: Coordinates | null;
  precision: Precision;
}

export interface PlaceDetails {
  placeId: string | null;
  formatted: string;
  address: StructuredAddress;
  coordinates: Coordinates | null;
  precision: Precision;
}

export type DistanceBasis =
  /** A real road route. */
  | 'ROUTE'
  /** The great circle between two points — always shorter than any road. */
  | 'STRAIGHT_LINE'
  /** Not known, and not to be guessed at. */
  | 'NONE';

export interface RouteResult {
  kilometres: number;
  /** Seconds, where the provider gave one. */
  seconds: number | null;
  basis: DistanceBasis;
}

/** Everything an adapter needs, resolved from the admin or the environment. */
export interface ProviderRuntime {
  provider: string;
  baseUrl: string;
  apiKey: string | null;
  publicToken: string | null;
  options: Record<string, unknown>;
  timeoutMs: number;
  /** Shown wherever this provider's data appears. */
  attribution: string;
}

/**
 * One provider, as the application sees it.
 *
 * Every method is optional: an adapter implements what its provider does and
 * nothing else, and the registry only ever calls a method the provider's
 * declared capabilities say exists.
 */
export interface MapsAdapter {
  id: string;
  capabilities: MapsCapability[];
  autocomplete?(runtime: ProviderRuntime, query: string, near?: Coordinates): Promise<AddressSuggestion[]>;
  placeDetails?(runtime: ProviderRuntime, placeId: string): Promise<PlaceDetails | null>;
  geocode?(runtime: ProviderRuntime, address: string): Promise<PlaceDetails | null>;
  reverseGeocode?(runtime: ProviderRuntime, point: Coordinates): Promise<PlaceDetails | null>;
  routeDistance?(runtime: ProviderRuntime, from: Coordinates, to: Coordinates): Promise<RouteResult | null>;
}

/** Thrown by an adapter so the registry can tell a bad key from a bad network. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'quota' | 'network' | 'unsupported' | 'bad_response' | 'not_found',
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Valid, and not the null island a failed parse so often produces. */
export function isUsableCoordinate(lat: unknown, lng: unknown): boolean {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a < -90 || a > 90 || b < -180 || b > 180) return false;
  return Math.abs(a) > 0.0001 || Math.abs(b) > 0.0001;
}

/** Great-circle distance in kilometres. Never presented as a road distance. */
export function haversineKm(from: Coordinates, to: Coordinates): number {
  const R = 6371;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(to.latitude - from.latitude);
  const dLng = rad(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(from.latitude)) * Math.cos(rad(to.latitude)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 1000) / 1000;
}
