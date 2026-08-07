import type { ShipmentStatus } from '@prisma/client';

import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';

/**
 * Delivery gateway adapters.
 *
 * Two shapes cover what businesses actually need. `MANUAL` is a business's own
 * riders or a courier they phone up: nothing is called, the status is driven
 * from the app. `HTTP` is a configurable client for any courier or internal
 * dispatch service that speaks JSON over HTTPS — the endpoint, auth header and
 * response field names all come from the provider's own settings, so wiring a
 * new courier is configuration rather than code.
 *
 * Every adapter can also receive tracking callbacks; that path is shared and
 * lives in delivery.service.
 */

export interface AdapterField {
  key: string;
  label: string;
  /** Stored in `credentials` and never returned to the client. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface BookingRequest {
  reference: string;
  amount: string | null;
  currency: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  dropoffAddress: string | null;
  pickupAddress: string | null;
  notes: string | null;
  itemCount: number;
}

export interface BookingResult {
  externalId: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  cost: string | null;
  currency: string | null;
  estimatedAt: Date | null;
  status: ShipmentStatus;
  statusDetail: string | null;
  raw?: unknown;
}

export interface DeliveryAdapter {
  key: string;
  label: string;
  description: string;
  /** False when the gateway is driven entirely by hand (own riders). */
  supportsBooking: boolean;
  credentialFields: AdapterField[];
  settingFields: AdapterField[];
  book(
    req: BookingRequest,
    config: { credentials: Record<string, unknown>; settings: Record<string, unknown> }
  ): Promise<BookingResult>;
}

/**
 * Carrier vocabulary → our `ShipmentStatus`. Couriers all invent their own
 * wording, so anything unrecognised is left for the provider's own `statusMap`
 * rather than being guessed at.
 */
const DEFAULT_STATUS_MAP: Record<string, ShipmentStatus> = {
  pending: 'PENDING',
  created: 'PENDING',
  confirmed: 'PENDING',
  awaiting_pickup: 'LABEL_CREATED',
  label_created: 'LABEL_CREATED',
  ready: 'LABEL_CREATED',
  assigned: 'LABEL_CREATED',
  picked_up: 'PICKED_UP',
  pickup: 'PICKED_UP',
  collected: 'PICKED_UP',
  in_transit: 'IN_TRANSIT',
  transit: 'IN_TRANSIT',
  shipped: 'IN_TRANSIT',
  out_for_delivery: 'OUT_FOR_DELIVERY',
  delivering: 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  completed: 'DELIVERED',
  failed: 'FAILED',
  cancelled: 'FAILED',
  canceled: 'FAILED',
  returned: 'RETURNED',
  return: 'RETURNED',
};

/**
 * Resolve a carrier's status word. The provider's own map wins, so a courier
 * that says "ON_ROUTE" can be taught without a deploy.
 */
export function mapCarrierStatus(
  raw: string | null | undefined,
  overrides?: Record<string, string> | null
): ShipmentStatus | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const override = overrides?.[key] ?? overrides?.[raw.trim()];
  if (override && isShipmentStatus(override)) return override;
  return DEFAULT_STATUS_MAP[key] ?? null;
}

const SHIPMENT_STATUSES: ShipmentStatus[] = [
  'PENDING', 'LABEL_CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED',
];
export function isShipmentStatus(v: string): v is ShipmentStatus {
  return (SHIPMENT_STATUSES as string[]).includes(v);
}

/** Read `a.b.c` out of a parsed JSON body without throwing on a missing hop. */
function pick(body: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc === null || acc === undefined) return undefined;
    if (Array.isArray(acc)) return acc[Number(part)];
    if (typeof acc === 'object') return (acc as Record<string, unknown>)[part];
    return undefined;
  }, body);
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const manualAdapter: DeliveryAdapter = {
  key: 'MANUAL',
  label: 'Own riders / manual courier',
  description:
    'For deliveries you handle yourself or book by phone. Nothing is called out to; you move the delivery through its stages in the app and the order status follows.',
  supportsBooking: false,
  credentialFields: [],
  settingFields: [
    { key: 'pickupAddress', label: 'Default pickup address', placeholder: 'Where riders collect from' },
    {
      key: 'trackingUrlTemplate',
      label: 'Tracking link template',
      placeholder: 'https://track.example.com/{{trackingNumber}}',
      help: 'Optional. {{trackingNumber}} is substituted when you record one.',
    },
  ],
  async book(req, config) {
    const template = str(config.settings.trackingUrlTemplate);
    return {
      externalId: null,
      trackingNumber: null,
      trackingUrl: template ? template.replace('{{trackingNumber}}', req.reference) : null,
      labelUrl: null,
      cost: null,
      currency: null,
      estimatedAt: null,
      status: 'PENDING',
      statusDetail: 'Awaiting pickup',
    };
  },
};

const httpAdapter: DeliveryAdapter = {
  key: 'HTTP',
  label: 'Courier API (HTTP)',
  description:
    'Connect any courier or dispatch service with a JSON API. You give the booking URL, the auth header and where in the response the tracking details sit.',
  supportsBooking: true,
  credentialFields: [
    { key: 'apiKey', label: 'API key / token', secret: true, required: true },
  ],
  settingFields: [
    { key: 'bookUrl', label: 'Booking endpoint', required: true, placeholder: 'https://api.courier.com/v1/deliveries' },
    { key: 'authHeader', label: 'Auth header name', placeholder: 'Authorization' },
    { key: 'authScheme', label: 'Auth scheme', placeholder: 'Bearer' },
    { key: 'externalIdPath', label: 'Response path — delivery id', placeholder: 'data.id' },
    { key: 'trackingNumberPath', label: 'Response path — tracking number', placeholder: 'data.tracking_code' },
    { key: 'trackingUrlPath', label: 'Response path — tracking URL', placeholder: 'data.tracking_url' },
    { key: 'labelUrlPath', label: 'Response path — label URL', placeholder: 'data.label_url' },
    { key: 'costPath', label: 'Response path — price', placeholder: 'data.amount' },
    { key: 'statusPath', label: 'Response path — status', placeholder: 'data.status' },
    { key: 'pickupAddress', label: 'Default pickup address' },
    {
      key: 'statusMap',
      label: 'Status mapping (JSON)',
      placeholder: '{"on_route":"IN_TRANSIT"}',
      help: 'Only needed for wording we do not already recognise.',
    },
  ],
  async book(req, config) {
    const url = str(config.settings.bookUrl);
    if (!url) throw new AppError('DELIVERY_NOT_CONFIGURED', 400, 'This gateway has no booking endpoint configured.');
    const apiKey = str(config.credentials.apiKey);

    const headerName = str(config.settings.authHeader) ?? 'Authorization';
    const scheme = str(config.settings.authScheme) ?? 'Bearer';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers[headerName] = scheme ? `${scheme} ${apiKey}` : apiKey;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          reference: req.reference,
          amount: req.amount,
          currency: req.currency,
          recipient: { name: req.recipientName, phone: req.recipientPhone, address: req.dropoffAddress },
          pickup: { address: req.pickupAddress ?? str(config.settings.pickupAddress) },
          items: req.itemCount,
          notes: req.notes,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // A courier being down must not lose the dispatch — say so plainly so the
      // operator can fall back to booking it by hand.
      logger.error({ err, url }, 'delivery gateway unreachable');
      throw new AppError('DELIVERY_GATEWAY_UNREACHABLE', 502, 'The delivery gateway did not respond. Try again, or book this delivery manually.');
    }

    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      throw new AppError(
        'DELIVERY_GATEWAY_REJECTED',
        502,
        `The delivery gateway refused this booking (HTTP ${res.status}).`
      );
    }

    const overrides = parseStatusMap(config.settings.statusMap);
    const rawStatus = str(pick(body, str(config.settings.statusPath) ?? 'status'));
    const costValue = str(pick(body, str(config.settings.costPath) ?? undefined));

    return {
      externalId: str(pick(body, str(config.settings.externalIdPath) ?? 'id')),
      trackingNumber: str(pick(body, str(config.settings.trackingNumberPath) ?? 'tracking_number')),
      trackingUrl: str(pick(body, str(config.settings.trackingUrlPath) ?? 'tracking_url')),
      labelUrl: str(pick(body, str(config.settings.labelUrlPath) ?? 'label_url')),
      cost: costValue !== null && /^\d+(\.\d+)?$/.test(costValue) ? costValue : null,
      currency: req.currency,
      estimatedAt: null,
      status: mapCarrierStatus(rawStatus, overrides) ?? 'LABEL_CREATED',
      statusDetail: rawStatus,
      raw: body,
    };
  },
};

/** `statusMap` is operator-entered, so tolerate it being a string or absent. */
export function parseStatusMap(value: unknown): Record<string, string> | null {
  if (!value) return null;
  if (typeof value === 'object') return value as Record<string, string>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export const DELIVERY_ADAPTERS: Record<string, DeliveryAdapter> = {
  MANUAL: manualAdapter,
  HTTP: httpAdapter,
};

export const DELIVERY_ADAPTER_KEYS = Object.keys(DELIVERY_ADAPTERS) as [string, ...string[]];

export function getAdapter(key: string): DeliveryAdapter {
  const adapter = DELIVERY_ADAPTERS[key];
  if (!adapter) throw new AppError('UNKNOWN_DELIVERY_ADAPTER', 400, `Unknown delivery adapter "${key}".`);
  return adapter;
}

/** What the settings UI needs to render the connect form for each gateway. */
export const adapterCatalog = () =>
  Object.values(DELIVERY_ADAPTERS).map((a) => ({
    key: a.key,
    label: a.label,
    description: a.description,
    supportsBooking: a.supportsBooking,
    credentialFields: a.credentialFields,
    settingFields: a.settingFields,
  }));
