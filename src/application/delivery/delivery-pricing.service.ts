import { Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import {
  readFulfilmentSettings,
  resolveOrigin,
  formatAddress,
  type FulfilmentAddress,
  type FulfilmentConfig,
} from './fulfilment-settings.service';
import {
  distanceBetween,
  geocode,
  isUsableCoordinate,
  mapsConfigured,
  type Coordinates,
  type DistanceBasis,
} from './geo.service';
import { deliveryServiceByProvider } from './delivery-config-sync';
import { quoteFromCarrier } from './carrier-rates.service';
import { carrierCredentialFor } from './carrier-credentials.service';

/**
 * What a delivery costs — decided here and nowhere else.
 *
 * Checkout, invoice recalculation and order creation all ask this one
 * function. That is the point of it: three implementations of the same
 * formula is three chances for the customer to be shown one number and
 * charged another.
 *
 * Nothing the browser sends is trusted. The caller passes identifiers and a
 * destination; the weights, the rates, the origin and the distance are all
 * read here, server-side, from the business's own records.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;
const GRAMS_PER_KG = 1000;

/** Why a destination could not be priced. The caller shows a different thing for each. */
export type QuoteOutcome =
  | 'OK'
  /** Beyond the business's configured service radius. */
  | 'OUT_OF_RANGE'
  /** The address could not be placed on a map, so distance is unknowable. */
  | 'UNRESOLVED_ADDRESS'
  /** Weight is charged for but some item's weight is unknown. */
  | 'MISSING_WEIGHT'
  /** Priced by hand: the business said so, for this case. */
  | 'MANUAL_QUOTE'
  /** The business has delivery switched off. */
  | 'DELIVERY_DISABLED'
  /** A carrier was asked and would not or could not price it. */
  | 'CARRIER_UNAVAILABLE';

export interface DeliveryDestination {
  address: FulfilmentAddress;
  /** From a map pin or a previous geocode. Re-validated here either way. */
  latitude?: number | null;
  longitude?: number | null;
}

export interface QuoteItem {
  variantId: string;
  quantity: number;
}

/** Each component, kept apart so a customer can be shown what they are paying for. */
export interface DeliveryFeeBreakdown {
  base: number;
  distance: number;
  weight: number;
  /** Negative when a minimum or a ceiling moved the total. */
  adjustment: number;
  total: number;
  currency: string;
}

export interface DeliveryQuote {
  outcome: QuoteOutcome;
  /** True only for OK. Convenience, because every caller asks. */
  priced: boolean;
  fee: DeliveryFeeBreakdown;
  /** What the customer is told when `outcome` is not OK. */
  message: string | null;
  distance: { kilometres: number | null; basis: DistanceBasis };
  weight: {
    grams: number;
    /** Items whose weight had to be assumed, by name. */
    assumed: string[];
    /** Items with no usable weight at all. */
    unknown: string[];
  };
  origin: { name: string; address: string; latitude: number | null; longitude: number | null };
  destination: {
    address: FulfilmentAddress;
    formatted: string;
    latitude: number | null;
    longitude: number | null;
  };
  /** The rates used, frozen, so a historic fee can be explained. */
  rates: {
    baseFee: number;
    perKm: number;
    perKg: number;
    minFee: number;
    maxFee: number | null;
    freeOverSubtotal: number | null;
  };
  currency: string;
  quotedAt: string;
  expiresAt: string;
  /**
   * How this figure was arrived at, and by whom.
   *
   * Kept with the order so a fee on a paid invoice can be explained later:
   * "our own rates" and "what DHL quoted on the day" are different answers to
   * the same question, and only one of them can be recomputed.
   */
  pricedBy: {
    mode: 'BUSINESS_RATES' | 'CARRIER' | 'MANUAL_ONLY';
    provider: string | null;
    account: 'PLATFORM' | 'OWN' | null;
    /** The carrier's own handle for the quote, where it gave one. */
    reference: string | null;
  };
  /** Shown wherever this quote's distance or address is displayed. */
  attribution: string;
}

/**
 * What one unit of a variant weighs, and where that came from.
 *
 * The variant wins when it has a weight of its own, because that is the thing
 * being shipped. A missing variant weight falls back to the product, which is
 * right for a catalogue where every size weighs the same and only the parent
 * was filled in. Both missing is *unknown*, never zero.
 */
async function weighItems(
  organizationId: string,
  items: QuoteItem[],
): Promise<{ grams: number; assumed: string[]; unknown: string[] }> {
  if (items.length === 0) return { grams: 0, assumed: [], unknown: [] };
  const variants = await prismaUnscoped.productVariant.findMany({
    where: { id: { in: items.map((i) => i.variantId) }, organizationId },
    select: {
      id: true,
      sku: true,
      name: true,
      weightGrams: true,
      product: { select: { name: true, weightGrams: true } },
    },
  });
  const byId = new Map(variants.map((v) => [v.id, v]));

  let grams = 0;
  const unknown: string[] = [];
  for (const item of items) {
    const variant = byId.get(item.variantId);
    if (!variant) continue;
    const per = variant.weightGrams ?? variant.product?.weightGrams ?? null;
    const label = variant.name || variant.product?.name || variant.sku;
    if (per === null) {
      if (!unknown.includes(label)) unknown.push(label);
      continue;
    }
    grams += per * item.quantity;
  }
  return { grams, assumed: [], unknown };
}

function emptyFee(currency: string): DeliveryFeeBreakdown {
  return { base: 0, distance: 0, weight: 0, adjustment: 0, total: 0, currency };
}

/** A destination complete enough to be worth looking up. */
export function destinationIsComplete(address: FulfilmentAddress): boolean {
  return Boolean(address.line1?.trim() && address.city?.trim() && address.country?.trim());
}

export interface QuoteInput {
  organizationId: string;
  items: QuoteItem[];
  destination: DeliveryDestination;
  /** Basket value before delivery, for the free-delivery threshold. */
  subtotal?: number;
  /** Supplied by tests and by re-pricing; defaults to the business's own. */
  config?: FulfilmentConfig;
}

export async function quoteDelivery(input: QuoteInput): Promise<DeliveryQuote> {
  const config = input.config ?? (await readFulfilmentSettings(input.organizationId));
  const currency = config.currency;
  const { pricing } = config.delivery;
  const now = new Date();
  const origin = resolveOrigin(config);

  const base = (outcome: QuoteOutcome, message: string | null, extra: Partial<DeliveryQuote> = {}): DeliveryQuote => ({
    outcome,
    priced: outcome === 'OK',
    fee: emptyFee(currency),
    message,
    distance: { kilometres: null, basis: 'NONE' },
    weight: { grams: 0, assumed: [], unknown: [] },
    origin: {
      name: origin.name,
      address: formatAddress(origin.address),
      latitude: origin.latitude,
      longitude: origin.longitude,
    },
    destination: {
      address: input.destination.address,
      formatted: formatAddress(input.destination.address),
      latitude: null,
      longitude: null,
    },
    rates: {
      baseFee: pricing.baseFee,
      perKm: pricing.perKm,
      perKg: pricing.perKg,
      minFee: pricing.minFee,
      maxFee: pricing.maxFee,
      freeOverSubtotal: pricing.freeOverSubtotal,
    },
    currency,
    quotedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.delivery.quoteValidMinutes * 60_000).toISOString(),
    pricedBy: {
      mode: config.delivery.mode,
      provider: config.delivery.mode === 'CARRIER' ? config.delivery.carrierProvider || null : null,
      account: config.delivery.mode === 'CARRIER' ? config.delivery.carrierAccount : null,
      reference: null,
    },
    attribution: '',
    ...extra,
  });

  if (!config.delivery.enabled) {
    return base('DELIVERY_DISABLED', 'This business does not offer delivery.');
  }
  if (!destinationIsComplete(input.destination.address)) {
    return base('UNRESOLVED_ADDRESS', 'Enter a street address, city and country so we can work out delivery.');
  }

  /*
   * A business that prices every delivery by hand says so here.
   *
   * Nothing is guessed and nothing is charged: the order is taken, the
   * customer is told what happens next, and the fee is agreed afterwards.
   */
  if (config.delivery.mode === 'MANUAL_ONLY') {
    return base('MANUAL_QUOTE', config.delivery.manualQuoteMessage);
  }

  /*
   * A carrier prices its own deliveries.
   *
   * The business's rate card is not consulted, because adding a base fee to a
   * courier's quote charges the customer twice for the same journey — the
   * courier has already priced the distance and the weight.
   */
  if (config.delivery.mode === 'CARRIER') {
    const weighed = await weighItems(input.organizationId, input.items);
    const service = deliveryServiceByProvider(config.delivery.carrierProvider);
    if (!service) {
      return base(
        'CARRIER_UNAVAILABLE',
        'The delivery service this business uses is no longer available. Please contact them to arrange delivery.',
        { weight: weighed },
      );
    }
    if (weighed.unknown.length > 0) {
      // A courier prices by weight. Sending it a short weight would produce a
      // quote the business is then billed above.
      return base(
        'MISSING_WEIGHT',
        `We cannot price delivery for ${weighed.unknown.join(', ')} yet. Please contact us to complete this order.`,
        { weight: weighed },
      );
    }

    const credential =
      config.delivery.carrierAccount === 'OWN'
        ? await carrierCredentialFor(input.organizationId, service.provider)
        : { apiKeyEnc: null, options: {} };

    const quote = await quoteFromCarrier({
      service,
      businessApiKeyEnc: credential.apiKeyEnc,
      businessOptions: { ...config.delivery.carrierOptions, ...credential.options },
      origin: { address: origin.address, latitude: origin.latitude, longitude: origin.longitude },
      destination: {
        address: input.destination.address,
        latitude: input.destination.latitude ?? null,
        longitude: input.destination.longitude ?? null,
      },
      weightGrams: weighed.grams,
      subtotal: input.subtotal ?? 0,
      currency,
    });

    if (!quote.ok) {
      return config.delivery.unsupportedDestination === 'MANUAL_QUOTE'
        ? base('MANUAL_QUOTE', config.delivery.manualQuoteMessage, { weight: weighed })
        : base('CARRIER_UNAVAILABLE', quote.error, { weight: weighed });
    }

    return base('OK', null, {
      fee: {
        base: quote.amount,
        distance: 0,
        weight: 0,
        adjustment: 0,
        total: quote.amount,
        currency,
      },
      weight: weighed,
      // The courier priced the journey; we did not measure it, and should not
      // imply we did.
      distance: { kilometres: null, basis: 'NONE' },
      destination: {
        address: input.destination.address,
        formatted: formatAddress(input.destination.address),
        latitude: input.destination.latitude ?? null,
        longitude: input.destination.longitude ?? null,
      },
      pricedBy: {
        mode: 'CARRIER',
        provider: service.provider,
        account: config.delivery.carrierAccount,
        reference: quote.reference,
      },
      // A carrier's own expiry wins when it gave one — it is the one that
      // actually binds.
      ...(quote.expiresAt ? { expiresAt: quote.expiresAt } : {}),
    });
  }

  // ── Weight ──────────────────────────────────────────────────────────────
  const weighed = await weighItems(input.organizationId, input.items);
  const weight = { ...weighed };
  const chargesForWeight = pricing.perKg > 0;

  if (weight.unknown.length > 0 && chargesForWeight) {
    if (config.delivery.missingWeight === 'BLOCK') {
      return base(
        'MISSING_WEIGHT',
        `We cannot price delivery for ${weight.unknown.join(', ')} yet. Please contact us to complete this order.`,
        { weight },
      );
    }
    if (config.delivery.missingWeight === 'MANUAL_QUOTE') {
      return base('MANUAL_QUOTE', config.delivery.manualQuoteMessage, { weight });
    }
    // ASSUME_DEFAULT: charge the business's stated assumption and say so.
    const per = config.delivery.defaultItemWeightGrams;
    const unknownNames = new Set(weight.unknown);
    const variants = await prismaUnscoped.productVariant.findMany({
      where: { id: { in: input.items.map((i) => i.variantId) }, organizationId: input.organizationId },
      select: { id: true, sku: true, name: true, weightGrams: true, product: { select: { name: true, weightGrams: true } } },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));
    for (const item of input.items) {
      const v = byId.get(item.variantId);
      if (!v) continue;
      const label = v.name || v.product?.name || v.sku;
      if (unknownNames.has(label) && (v.weightGrams ?? v.product?.weightGrams ?? null) === null) {
        weight.grams += per * item.quantity;
      }
    }
    weight.assumed = weight.unknown;
    weight.unknown = [];
  }

  // ── Distance ────────────────────────────────────────────────────────────
  const chargesForDistance = pricing.perKm > 0 || pricing.maxDistanceKm !== null;
  let destinationCoords: Coordinates | null = isUsableCoordinate(
    input.destination.latitude,
    input.destination.longitude,
  )
    ? { latitude: Number(input.destination.latitude), longitude: Number(input.destination.longitude) }
    : null;
  let formatted = formatAddress(input.destination.address);
  let kilometres: number | null = null;
  let basis: DistanceBasis = 'NONE';
  // Whoever's data ends up behind the figure has to be credited wherever it
  // is shown — a licence condition for every open-data provider here.
  let attribution = '';

  if (chargesForDistance) {
    if (!destinationCoords) {
      const located = await geocode(formatted);
      attribution = located.attribution || attribution;
      if (!located.coordinates) {
        // A rate that depends on distance cannot be charged without one. Which
        // way that falls is the business's decision, not a silent zero.
        return config.delivery.unsupportedDestination === 'MANUAL_QUOTE'
          ? base('MANUAL_QUOTE', config.delivery.manualQuoteMessage, { weight })
          : base(
              'UNRESOLVED_ADDRESS',
              mapsConfigured()
                ? `${located.error ?? 'That address could not be found'}. Check the address, or contact us to arrange delivery.`
                : 'We could not work out the delivery distance for that address. Please contact us to arrange delivery.',
              { weight },
            );
      }
      destinationCoords = located.coordinates;
      formatted = located.formatted ?? formatted;
    }

    if (!isUsableCoordinate(origin.latitude, origin.longitude)) {
      return config.delivery.unsupportedDestination === 'MANUAL_QUOTE'
        ? base('MANUAL_QUOTE', config.delivery.manualQuoteMessage, { weight })
        : base(
            'UNRESOLVED_ADDRESS',
            'This business has not set the location it delivers from, so distance cannot be calculated.',
            { weight },
          );
    }

    const measured = await distanceBetween(
      { latitude: origin.latitude as number, longitude: origin.longitude as number },
      destinationCoords,
    );
    kilometres = measured.kilometres;
    basis = measured.basis;
    attribution = measured.attribution || attribution;

    if (kilometres === null) {
      return base('UNRESOLVED_ADDRESS', 'We could not work out the delivery distance for that address.', { weight });
    }
    if (pricing.maxDistanceKm !== null && kilometres > pricing.maxDistanceKm) {
      return config.delivery.unsupportedDestination === 'MANUAL_QUOTE'
        ? base('MANUAL_QUOTE', config.delivery.manualQuoteMessage, {
            weight,
            distance: { kilometres, basis },
          })
        : base(
            'OUT_OF_RANGE',
            `That address is ${kilometres.toFixed(1)} km away, beyond the ${pricing.maxDistanceKm} km we deliver to.`,
            { weight, distance: { kilometres, basis } },
          );
    }
  }

  // ── The money ───────────────────────────────────────────────────────────
  // Decimal throughout: a per-kilometre rate times a fractional distance is
  // exactly where binary floating point starts costing someone a penny.
  const d = (n: number) => new Prisma.Decimal(n);
  const distanceCharge = kilometres === null ? d(0) : d(pricing.perKm).mul(d(kilometres));
  const weightCharge = d(pricing.perKg).mul(d(weight.grams).div(GRAMS_PER_KG));
  const raw = d(pricing.baseFee).add(distanceCharge).add(weightCharge);

  let total = raw;
  const freeThreshold = pricing.freeOverSubtotal;
  const qualifiesFree =
    freeThreshold !== null && input.subtotal !== undefined && input.subtotal >= freeThreshold;
  if (qualifiesFree) {
    total = d(0);
  } else {
    if (total.lessThan(d(pricing.minFee))) total = d(pricing.minFee);
    if (pricing.maxFee !== null && total.greaterThan(d(pricing.maxFee))) total = d(pricing.maxFee);
  }

  const fee: DeliveryFeeBreakdown = {
    base: round2(pricing.baseFee),
    distance: round2(distanceCharge.toNumber()),
    weight: round2(weightCharge.toNumber()),
    adjustment: round2(total.sub(raw).toNumber()),
    total: round2(total.toNumber()),
    currency,
  };

  return base('OK', null, {
    fee,
    weight,
    distance: { kilometres, basis },
    destination: {
      address: input.destination.address,
      formatted,
      latitude: destinationCoords?.latitude ?? null,
      longitude: destinationCoords?.longitude ?? null,
    },
    attribution,
  });
}

/** The pickup "fee" — almost always nothing, but a business may charge. */
export function pickupFee(config: FulfilmentConfig): DeliveryFeeBreakdown {
  return {
    base: round2(config.pickup.fee),
    distance: 0,
    weight: 0,
    adjustment: 0,
    total: round2(config.pickup.fee),
    currency: config.currency,
  };
}

/**
 * Whether an accepted quote may still be charged.
 *
 * A quote carries an expiry because the rates behind it can change. Past it,
 * checkout re-prices and asks the customer again rather than charging a figure
 * nobody has agreed to.
 */
export function quoteIsFresh(quote: { expiresAt?: string | null } | null | undefined): boolean {
  if (!quote?.expiresAt) return false;
  const at = Date.parse(quote.expiresAt);
  return Number.isFinite(at) && at > Date.now();
}
