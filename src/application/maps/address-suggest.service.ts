import { prismaUnscoped } from '../../infrastructure/database/prisma';
import {
  autocompleteAvailable,
  resolvePlace,
  reverseGeocode,
  suggestAddresses,
  type AddressSuggestion,
  type Coordinates,
} from './maps.service';
import { isUsableCoordinate } from '../../infrastructure/maps/types';

/**
 * Address suggestions, from the business's own records first.
 *
 * A business deals with a small, repetitive set of places, and its own
 * customer and supplier addresses are the most accurate source available for
 * them. They cost nothing, they need no provider, and they do not send a
 * half-typed customer address to a third party. So they are offered first, and
 * the external provider fills in everything it has not seen before.
 *
 * Local suggestions are marked as such, and carry no coordinates unless the
 * stored record had them — a remembered address is not a verified one.
 */

export type SuggestionSource = 'saved' | 'provider';

export interface Suggestion extends AddressSuggestion {
  source: SuggestionSource;
  /**
   * Whether a provider has placed this on a map.
   *
   * The word matters. A customer who picked a line off a dropdown has
   * *suggested* an address; only a resolved point makes it verified, and only
   * a verified one can be charged by the kilometre.
   */
  verified: boolean;
}

export interface SuggestResult {
  suggestions: Suggestion[];
  /** Required wherever these are displayed. Empty for purely local results. */
  attribution: string;
  provider: string | null;
  /** True when a provider is configured at all — the UI offers manual entry otherwise. */
  providerAvailable: boolean;
  /** Null when all is well; a sentence to show beside the field otherwise. */
  error: string | null;
}

/** Addresses this business has already used, matched loosely. */
async function savedAddresses(organizationId: string, query: string): Promise<Suggestion[]> {
  const text = query.trim();
  if (text.length < 3) return [];

  const rows = await prismaUnscoped.customerAddress.findMany({
    where: {
      customer: { organizationId },
      OR: [
        { addressLine1: { contains: text, mode: 'insensitive' } },
        { city: { contains: text, mode: 'insensitive' } },
      ],
    },
    select: {
      addressLine1: true, addressLine2: true, city: true, state: true,
      country: true, postalCode: true, latitude: true, longitude: true,
    },
    take: 4,
    orderBy: { updatedAt: 'desc' },
  });

  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const row of rows) {
    const formatted = [row.addressLine1, row.addressLine2, row.city, row.state, row.postalCode, row.country]
      .filter(Boolean)
      .join(', ');
    if (!formatted || seen.has(formatted.toLowerCase())) continue;
    seen.add(formatted.toLowerCase());
    const hasPoint = isUsableCoordinate(row.latitude, row.longitude);
    out.push({
      placeId: null,
      formatted,
      address: {
        line1: row.addressLine1,
        line2: row.addressLine2 ?? undefined,
        city: row.city,
        state: row.state ?? undefined,
        postalCode: row.postalCode ?? undefined,
        country: row.country,
      },
      coordinates: hasPoint ? { latitude: Number(row.latitude), longitude: Number(row.longitude) } : null,
      precision: hasPoint ? 'rooftop' : 'unknown',
      source: 'saved',
      // Only if it was geocoded when it was saved. A remembered line of text
      // is a convenience, not a verification.
      verified: hasPoint,
    });
  }
  return out;
}

export async function suggest(input: {
  organizationId: string;
  query: string;
  /** Bias results towards here — usually where the business is. */
  near?: Coordinates | null;
  /** Skip the address book for a public checkout, which is not the business's. */
  includeSaved?: boolean;
}): Promise<SuggestResult> {
  const query = input.query.trim();
  if (query.length < 3) {
    return {
      suggestions: [],
      attribution: '',
      provider: null,
      providerAvailable: autocompleteAvailable(),
      error: null,
    };
  }

  const saved = input.includeSaved === false ? [] : await savedAddresses(input.organizationId, query);
  const remote = await suggestAddresses(query, input.near);

  const seen = new Set(saved.map((s) => s.formatted.toLowerCase()));
  const provider: Suggestion[] = remote.suggestions
    .filter((s) => !seen.has(s.formatted.toLowerCase()))
    .map((s) => ({
      ...s,
      source: 'provider' as const,
      // A provider that returned a point has verified it; one that returned
      // only a name and an id has not, and the details lookup is what will.
      verified: Boolean(s.coordinates),
    }));

  return {
    suggestions: [...saved, ...provider].slice(0, 8),
    attribution: remote.attribution,
    provider: remote.provider,
    providerAvailable: autocompleteAvailable(),
    // A provider failure is not an error for the whole field: the saved
    // addresses are still there and manual entry still works.
    error: remote.error,
  };
}

/** Turn a chosen suggestion into a point and structured parts. */
export async function resolveSuggestion(placeId: string): Promise<{
  details: Awaited<ReturnType<typeof resolvePlace>>['value'];
  attribution: string;
  verified: boolean;
}> {
  const resolved = await resolvePlace(placeId);
  return {
    details: resolved.value,
    attribution: resolved.attribution,
    verified: Boolean(resolved.value?.coordinates),
  };
}

export async function describePoint(point: Coordinates) {
  const resolved = await reverseGeocode(point);
  return { details: resolved.value, attribution: resolved.attribution };
}
