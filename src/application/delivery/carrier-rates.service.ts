import { decrypt } from '../../shared/crypto';
import { logger } from '../../shared/logger';
import { deliveryServiceByProvider, type PlatformDeliveryService } from './delivery-config-sync';
import type { FulfilmentAddress } from './fulfilment-settings.service';

/**
 * Asking a carrier what it would charge.
 *
 * Only the configurable HTTP adapter is implemented. That is deliberate rather
 * than lazy: a DHL or FedEx integration is a real piece of work with an
 * approved developer account behind it, and shipping a stub that returns a
 * plausible number would put a made-up price on a customer's invoice. The
 * catalogue lists those as unimplemented and the admin refuses to switch them
 * on, so nothing a business can select arrives here without an adapter.
 *
 * What the HTTP adapter buys is the long tail: a regional courier with a JSON
 * endpoint becomes configuration rather than a release.
 */

export interface CarrierQuoteRequest {
  service: PlatformDeliveryService;
  /** A business's own credential, when it connected its own account. */
  businessApiKeyEnc?: string | null;
  businessOptions?: Record<string, unknown>;
  origin: { address: FulfilmentAddress; latitude: number | null; longitude: number | null };
  destination: { address: FulfilmentAddress; latitude: number | null; longitude: number | null };
  weightGrams: number;
  /** The basket value, which some carriers price insurance from. */
  subtotal: number;
  currency: string;
}

export interface CarrierQuote {
  ok: boolean;
  amount: number;
  currency: string;
  /** The carrier's own handle for this quote, kept with the order. */
  reference: string | null;
  /** Null when it worked; a sentence for the customer when it did not. */
  error: string | null;
  /** How long the carrier says the quote stands, if it said. */
  expiresAt: string | null;
}

const refuse = (error: string, currency: string): CarrierQuote => ({
  ok: false,
  amount: 0,
  currency,
  reference: null,
  error,
  expiresAt: null,
});

/** Walk a dotted path, because every carrier nests its price differently. */
function pluck(body: unknown, path: string): unknown {
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), body);
}

function readKey(encrypted: string | null | undefined): string | null {
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'carrier credential could not be read');
    return null;
  }
}

export async function quoteFromCarrier(input: CarrierQuoteRequest): Promise<CarrierQuote> {
  const { service, currency } = input;

  if (!service.capabilities.includes('rate_quote')) {
    // A dispatch-only integration can move a parcel but cannot say what to
    // charge for it. Treating the two as one is how a checkout ends up with
    // no price and a booked courier.
    return refuse(`${service.label ?? service.provider} can dispatch parcels but does not quote prices.`, currency);
  }

  if (service.provider !== 'http_carrier') {
    return refuse(
      `${service.label ?? service.provider} is listed but its integration is not available yet.`,
      currency,
    );
  }

  const options = { ...service.options, ...(input.businessOptions ?? {}) };
  const url = String(options.rateUrl ?? service.baseUrl ?? '').trim();
  if (!url) return refuse('This delivery service has no rate endpoint configured.', currency);

  // A business's own credential wins when it connected one; otherwise the
  // platform's, and only if the platform allows businesses to use it.
  const businessKey = readKey(input.businessApiKeyEnc);
  const key = businessKey ?? (service.allowPlatformCredentials ? service.apiKey : null);
  if (!key && !businessKey) {
    return refuse('This delivery service is not connected to an account that can quote.', currency);
  }

  const expectedCurrency = String(options.currency ?? currency).toUpperCase();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { [String(options.authHeader ?? 'Authorization')]: key } : {}),
      },
      body: JSON.stringify({
        origin: input.origin,
        destination: input.destination,
        weightGrams: input.weightGrams,
        subtotal: input.subtotal,
        currency,
      }),
    });
    if (!res.ok) {
      return refuse(`The courier could not price this delivery (HTTP ${res.status}).`, currency);
    }
    const body = (await res.json()) as unknown;
    const amount = Number(pluck(body, String(options.amountPath ?? 'amount')));
    if (!Number.isFinite(amount) || amount < 0) {
      return refuse('The courier did not return a usable price for this delivery.', currency);
    }

    /*
     * A quote in the wrong currency is refused rather than converted.
     *
     * Converting it here would put an exchange rate nobody agreed on into the
     * price the customer pays, and the difference would surface as a
     * reconciliation problem weeks later.
     */
    const quotedCurrency = String(pluck(body, String(options.currencyPath ?? 'currency')) ?? expectedCurrency).toUpperCase();
    if (quotedCurrency !== currency.toUpperCase()) {
      return refuse(
        `The courier quoted in ${quotedCurrency} but this order is in ${currency}.`,
        currency,
      );
    }

    const reference = pluck(body, String(options.referencePath ?? 'reference'));
    const expires = pluck(body, String(options.expiresPath ?? 'expiresAt'));
    return {
      ok: true,
      amount: Math.round(amount * 100) / 100,
      currency: currency.toUpperCase(),
      reference: reference ? String(reference) : null,
      error: null,
      expiresAt: expires ? String(expires) : null,
    };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    logger.warn(
      { provider: service.provider, err: aborted ? 'timeout' : (err as Error).message },
      'carrier rate quote failed',
    );
    return refuse(
      aborted ? 'The courier did not answer in time.' : 'The courier could not be reached.',
      currency,
    );
  } finally {
    clearTimeout(timer);
  }
}
