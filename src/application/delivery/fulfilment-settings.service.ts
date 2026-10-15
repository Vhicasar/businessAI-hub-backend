import { z } from 'zod';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';

/**
 * How a business hands goods over: collection, delivery, and what delivery
 * costs.
 *
 * Stored on `Organization.settings.fulfilment`, beside `payments` and
 * `invoicing`, because it is the same kind of thing — a business's standing
 * preferences — and putting it there means no new table and no migration for
 * every rate a business decides to add.
 *
 * Read through `readFulfilmentSettings`, which fills in defaults. The defaults
 * matter: a business that has never opened this page must still be able to
 * take money. So delivery is off and pickup is off until someone turns them
 * on, and a payment link for such a business behaves exactly as it did before
 * any of this existed — pay the amount, no questions asked.
 */

const addressSchema = z.object({
  line1: z.string().trim().max(180).default(''),
  line2: z.string().trim().max(180).default(''),
  city: z.string().trim().max(100).default(''),
  state: z.string().trim().max(100).default(''),
  country: z.string().trim().max(2).toUpperCase().default(''),
  postalCode: z.string().trim().max(30).default(''),
});
export type FulfilmentAddress = z.infer<typeof addressSchema>;

const coordinateSchema = z.object({
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
});

/**
 * What a delivery costs.
 *
 * Three independent components, each of which a business may simply leave at
 * zero. A flat-rate business sets a base fee and nothing else and never thinks
 * about distance or weight again; a courier-style business sets a rate per
 * kilometre; a business shipping heavy goods sets a rate per kilogram. The
 * rates are the business's own numbers in the business's own currency —
 * nothing here assumes a country.
 */
const pricingSchema = z.object({
  baseFee: z.number().min(0).max(100_000_000).default(0),
  /** Charged per kilometre of the resolved route. */
  perKm: z.number().min(0).max(1_000_000).default(0),
  /** Charged per kilogram of chargeable weight. */
  perKg: z.number().min(0).max(1_000_000).default(0),
  /** The fee never falls below this once the components are added up. */
  minFee: z.number().min(0).max(100_000_000).default(0),
  /** Null means no ceiling. */
  maxFee: z.number().min(0).max(100_000_000).nullable().default(null),
  /** Refuse to quote beyond this many kilometres. Null means no limit. */
  maxDistanceKm: z.number().min(0).max(100_000).nullable().default(null),
  /**
   * Orders at or above this basket value deliver free. Null switches it off —
   * which is different from zero, where *every* order would deliver free.
   */
  freeOverSubtotal: z.number().min(0).max(1_000_000_000).nullable().default(null),
});
export type DeliveryPricing = z.infer<typeof pricingSchema>;

export const fulfilmentSettingsSchema = z.object({
  pickup: z
    .object({
      enabled: z.boolean().default(false),
      locationName: z.string().trim().max(120).default(''),
      address: addressSchema.default({}),
      coordinates: coordinateSchema.default({}),
      /** Collection hours, what to bring, where to park — shown at checkout. */
      instructions: z.string().trim().max(2000).default(''),
      /** Almost always zero. Configurable because a few businesses do charge. */
      fee: z.number().min(0).max(100_000_000).default(0),
    })
    .default({}),
  delivery: z
    .object({
      enabled: z.boolean().default(false),
      /**
       * Where deliveries leave from.
       *
       * Most businesses dispatch from the place customers collect from, so the
       * default is to reuse the pickup address rather than ask for it twice.
       */
      originSameAsPickup: z.boolean().default(true),
      originName: z.string().trim().max(120).default(''),
      originAddress: addressSchema.default({}),
      originCoordinates: coordinateSchema.default({}),
      /**
       * Who works out the price, and who carries the parcel.
       *
       * BUSINESS_RATES is the business's own riders on its own rates.
       * CARRIER asks a delivery service configured by the platform — on the
       * platform's account, or on the business's own if it connected one.
       * MANUAL_ONLY takes the order and prices it by hand afterwards, which
       * is the honest answer for a business whose deliveries are negotiated.
       */
      mode: z.enum(['BUSINESS_RATES', 'CARRIER', 'MANUAL_ONLY']).default('BUSINESS_RATES'),
      /** The platform-catalogued service this business selected, under CARRIER. */
      carrierProvider: z.string().trim().max(40).default(''),
      /**
       * Whose account the carrier bills.
       *
       * PLATFORM uses the credential the operator configured centrally; OWN
       * uses the one this business connected, and its charges go to it
       * directly from the courier.
       */
      carrierAccount: z.enum(['PLATFORM', 'OWN']).default('PLATFORM'),
      /** Per-business carrier options — never secrets; those are encrypted. */
      carrierOptions: z.record(z.unknown()).default({}),
      pricing: pricingSchema.default({}),
      /**
       * What to do when an item's weight is unknown and the rates charge for
       * weight. Never "pretend it weighs nothing" — that is how a business
       * delivers a pallet for the price of an envelope.
       */
      missingWeight: z.enum(['ASSUME_DEFAULT', 'MANUAL_QUOTE', 'BLOCK']).default('MANUAL_QUOTE'),
      /** Grams assumed per unit under ASSUME_DEFAULT. */
      defaultItemWeightGrams: z.number().int().min(0).max(1_000_000).default(0),
      /**
       * What to do when the destination cannot be priced — outside the radius,
       * or no route could be resolved.
       */
      unsupportedDestination: z.enum(['BLOCK', 'MANUAL_QUOTE']).default('BLOCK'),
      /** Shown to a customer whose address cannot be priced automatically. */
      manualQuoteMessage: z
        .string()
        .trim()
        .max(600)
        .default('We will contact you with a delivery price before dispatch.'),
      /** Minutes an accepted quote stays good for. */
      quoteValidMinutes: z.number().int().min(5).max(60 * 24 * 14).default(60 * 24),
    })
    .default({}),
});

export type FulfilmentSettingsDto = z.input<typeof fulfilmentSettingsSchema>;
export type FulfilmentSettings = z.output<typeof fulfilmentSettingsSchema>;

/** Everything off, nothing assumed. Parsed so defaults come from one place. */
export const FULFILMENT_DEFAULTS: FulfilmentSettings = fulfilmentSettingsSchema.parse({});

/**
 * The settings, plus the currency they are denominated in.
 *
 * The rates are plain numbers; what they mean depends entirely on the
 * business's currency, so the two always travel together.
 */
export interface FulfilmentConfig extends FulfilmentSettings {
  currency: string;
  /**
   * Whether a real address lookup is available to this deployment.
   *
   * Surfaced so the settings page can warn a business that a per-kilometre
   * rate, with no mapping provider configured, will send every hand-typed
   * address to a manual quote. Better said out loud than discovered by a
   * customer at checkout.
   */
  mapsConfigured: boolean;
  /** The business's own address, for defaulting the pickup form. */
  businessAddress: FulfilmentAddress;
  businessCoordinates: { latitude: number | null; longitude: number | null };
}

function parse(stored: unknown): FulfilmentSettings {
  const result = fulfilmentSettingsSchema.safeParse(stored ?? {});
  // Stored settings predate any later tightening of the schema, and a business
  // must not lose the ability to take payments because one saved field no
  // longer validates. Fall back to the defaults rather than throwing.
  return result.success ? result.data : FULFILMENT_DEFAULTS;
}

export async function readFulfilmentSettings(organizationId: string): Promise<FulfilmentConfig> {
  const [org, profile] = await Promise.all([
    prismaUnscoped.organization.findUnique({
      where: { id: organizationId },
      select: {
        settings: true, currency: true, addressLine1: true, addressLine2: true,
        city: true, state: true, country: true, postalCode: true,
      },
    }),
    prismaUnscoped.businessProfile.findUnique({
      where: { organizationId },
      select: { latitude: true, longitude: true },
    }),
  ]);
  const settings = (org?.settings as Record<string, unknown>) ?? {};
  const { mapsConfigured } = await import('./geo.service');
  return {
    ...parse(settings.fulfilment),
    currency: org?.currency ?? 'USD',
    mapsConfigured: mapsConfigured(),
    businessAddress: {
      line1: org?.addressLine1 ?? '',
      line2: org?.addressLine2 ?? '',
      city: org?.city ?? '',
      state: org?.state ?? '',
      country: org?.country ?? '',
      postalCode: org?.postalCode ?? '',
    },
    businessCoordinates: {
      latitude: profile?.latitude === null || profile?.latitude === undefined ? null : Number(profile.latitude),
      longitude: profile?.longitude === null || profile?.longitude === undefined ? null : Number(profile.longitude),
    },
  };
}

/**
 * Where deliveries actually leave from, resolved.
 *
 * Collapses the "same as pickup" switch so callers never have to, and falls
 * back to the organisation's own address when neither has been filled in —
 * which is the common case for a business that has set coordinates on its
 * public profile but never opened this page.
 */
export function resolveOrigin(config: FulfilmentConfig): {
  name: string;
  address: FulfilmentAddress;
  latitude: number | null;
  longitude: number | null;
} {
  const fromPickup = config.delivery.originSameAsPickup;
  const address = fromPickup ? config.pickup.address : config.delivery.originAddress;
  const coords = fromPickup ? config.pickup.coordinates : config.delivery.originCoordinates;
  const hasAddress = Boolean(address.line1 || address.city);
  return {
    name: (fromPickup ? config.pickup.locationName : config.delivery.originName) || '',
    address: hasAddress ? address : config.businessAddress,
    latitude: coords.latitude ?? config.businessCoordinates.latitude,
    longitude: coords.longitude ?? config.businessCoordinates.longitude,
  };
}

/** One line, for a checkout page or a dispatch note. */
export function formatAddress(address: FulfilmentAddress): string {
  return [address.line1, address.line2, address.city, address.state, address.postalCode, address.country]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ');
}

export const fulfilmentSettingsService = {
  async get(): Promise<FulfilmentConfig> {
    const id = requestContext.get()?.organizationId;
    if (!id) throw new Error('No tenant in request context');
    return readFulfilmentSettings(id);
  },

  async save(dto: FulfilmentSettingsDto): Promise<FulfilmentConfig> {
    const id = requestContext.get()?.organizationId;
    if (!id) throw new Error('No tenant in request context');
    const parsed = fulfilmentSettingsSchema.parse(dto);
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id },
      select: { settings: true },
    });
    await prisma.organization.update({
      where: { id },
      data: { settings: { ...((org.settings as Record<string, unknown>) ?? {}), fulfilment: parsed } },
    });
    return readFulfilmentSettings(id);
  },
};
