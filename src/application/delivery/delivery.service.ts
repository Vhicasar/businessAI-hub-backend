import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { OrderStatus, Prisma, ShipmentStatus } from '@prisma/client';

import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import { emitEvent } from '../../shared/domain-events';
import { broadcast } from '../../infrastructure/realtime/live-events';
import { notifyCustomer } from '../notifications/notify';
import { logger } from '../../shared/logger';
import {
  DELIVERY_ADAPTER_KEYS,
  adapterCatalog,
  getAdapter,
  isShipmentStatus,
  mapCarrierStatus,
  parseStatusMap,
} from './adapters';

const currentOrgId = (): string => {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new ValidationError('No tenant in context');
  return id;
};

// ---------------------------------------------------------------- schemas

export const providerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  adapter: z.enum(DELIVERY_ADAPTER_KEYS).default('MANUAL'),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  credentials: z.record(z.string(), z.string().max(500)).optional(),
  settings: z.record(z.string(), z.union([z.string().max(1000), z.boolean(), z.number()])).optional(),
});
export const updateProviderSchema = providerSchema.partial();

export const dispatchSchema = z.object({
  /** Omit to use the organization's default gateway. */
  providerId: z.string().trim().optional(),
  recipientName: z.string().trim().max(160).optional(),
  recipientPhone: z.string().trim().max(40).optional(),
  dropoffAddress: z.string().trim().max(500).optional(),
  pickupAddress: z.string().trim().max(500).optional(),
  carrier: z.string().trim().max(120).optional(),
  /** Set when the delivery was booked outside the app. */
  trackingNumber: z.string().trim().max(120).optional(),
  trackingUrl: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const shipmentStatusSchema = z.object({
  status: z.enum(['PENDING', 'LABEL_CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED']),
  description: z.string().trim().max(300).optional(),
  location: z.string().trim().max(200).optional(),
  trackingNumber: z.string().trim().max(120).optional(),
  trackingUrl: z.string().trim().max(500).optional(),
});

export type ProviderDto = z.infer<typeof providerSchema>;
export type DispatchDto = z.infer<typeof dispatchSchema>;

// ------------------------------------------------------- status projection

/**
 * How far along the order a shipment status puts it. Delivery only ever pushes
 * an order *forward*: a courier retrying a callback, or a "failed attempt"
 * event arriving after a later one, must never drag a delivered order back.
 */
const ORDER_RANK: Record<OrderStatus, number> = {
  PENDING: 0,
  CONFIRMED: 1,
  PROCESSING: 2,
  PICKING: 3,
  PACKING: 4,
  READY_FOR_DISPATCH: 5,
  DISPATCHED: 6,
  IN_TRANSIT: 7,
  DELIVERED: 8,
  COMPLETED: 9,
  CANCELLED: 99,
  REFUNDED: 99,
};

const SHIPMENT_TO_ORDER: Partial<Record<ShipmentStatus, OrderStatus>> = {
  LABEL_CREATED: 'READY_FOR_DISPATCH',
  PICKED_UP: 'DISPATCHED',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
};

/** Customer-facing wording for each delivery stage. */
const SHIPMENT_LABEL: Record<ShipmentStatus, string> = {
  PENDING: 'Delivery booked',
  LABEL_CREATED: 'Ready for pickup',
  PICKED_UP: 'Picked up by the courier',
  IN_TRANSIT: 'On its way',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  FAILED: 'Delivery attempt failed',
  RETURNED: 'Returned to sender',
};

const maskCredentials = (credentials: Prisma.JsonValue | null): Record<string, boolean> => {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return {};
  // Report only *which* secrets are set. The values never leave the server.
  return Object.fromEntries(Object.entries(credentials).map(([k, v]) => [k, Boolean(v)]));
};

const providerView = (p: {
  id: string;
  name: string;
  adapter: string;
  isActive: boolean;
  isDefault: boolean;
  credentials: Prisma.JsonValue | null;
  settings: Prisma.JsonValue | null;
  webhookSecret: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: p.id,
  name: p.name,
  adapter: p.adapter,
  isActive: p.isActive,
  isDefault: p.isDefault,
  settings: (p.settings as Record<string, unknown>) ?? {},
  configuredSecrets: maskCredentials(p.credentials),
  hasWebhookSecret: Boolean(p.webhookSecret),
  webhookPath: `/api/v1/delivery/webhook/${p.id}`,
  lastUsedAt: p.lastUsedAt,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

const shipmentView = (s: {
  id: string;
  orderId: string;
  number: string;
  status: ShipmentStatus;
  statusDetail: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  cost: Prisma.Decimal | null;
  currency: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  dropoffAddress: string | null;
  notes: string | null;
  estimatedAt: Date | null;
  lastSyncedAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  providerId: string | null;
}) => ({
  id: s.id,
  orderId: s.orderId,
  number: s.number,
  status: s.status,
  statusLabel: SHIPMENT_LABEL[s.status],
  statusDetail: s.statusDetail,
  carrier: s.carrier,
  trackingNumber: s.trackingNumber,
  trackingUrl: s.trackingUrl,
  labelUrl: s.labelUrl,
  cost: s.cost?.toFixed(2) ?? null,
  currency: s.currency,
  recipientName: s.recipientName,
  recipientPhone: s.recipientPhone,
  dropoffAddress: s.dropoffAddress,
  notes: s.notes,
  estimatedAt: s.estimatedAt,
  lastSyncedAt: s.lastSyncedAt,
  shippedAt: s.shippedAt,
  deliveredAt: s.deliveredAt,
  createdAt: s.createdAt,
  providerId: s.providerId,
});

async function nextShipmentNumber(organizationId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prismaUnscoped.shipment.count({
    where: { organizationId, number: { startsWith: `SHP-${year}-` } },
  });
  return `SHP-${year}-${String(count + 1).padStart(5, '0')}`;
}

export const deliveryService = {
  adapterCatalog,

  // --------------------------------------------------------------- gateways

  async listProviders() {
    const rows = await prisma.deliveryProvider.findMany({
      where: { deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    return rows.map(providerView);
  },

  /**
   * Connect a gateway — or reconnect one of the same name that was removed.
   *
   * A removed gateway keeps its row so past shipments keep their history, and
   * `(organizationId, name)` is unique, so connecting the same courier again
   * would otherwise fail on a constraint the operator cannot see. Reusing the
   * name means reusing the record; its credentials and webhook secret are
   * replaced by whatever is supplied now.
   */
  async createProvider(dto: ProviderDto) {
    const organizationId = currentOrgId();
    // Unscoped so removed rows are visible — they still hold the unique name.
    const sameName = await prismaUnscoped.deliveryProvider.findFirst({
      where: { organizationId, name: dto.name },
    });
    if (sameName && sameName.deletedAt === null) {
      throw new ConflictError('A delivery gateway with this name already exists.');
    }

    const existingCount = await prisma.deliveryProvider.count({ where: { deletedAt: null } });
    if (dto.isDefault) await prisma.deliveryProvider.updateMany({ data: { isDefault: false } });

    const fields = {
      adapter: dto.adapter,
      isActive: dto.isActive ?? true,
      // The first gateway connected is the default — otherwise a business
      // sets one up and dispatch still asks them to choose every time.
      isDefault: dto.isDefault ?? existingCount === 0,
      credentials: (dto.credentials ?? {}) as Prisma.InputJsonValue,
      settings: (dto.settings ?? {}) as Prisma.InputJsonValue,
      webhookSecret: randomBytes(24).toString('hex'),
    };

    if (sameName) {
      const restored = await prismaUnscoped.deliveryProvider.update({
        where: { id: sameName.id },
        data: { ...fields, deletedAt: null },
      });
      await auditService.record({
        action: 'delivery_provider.reconnected',
        entityType: 'DeliveryProvider',
        entityId: restored.id,
        after: { name: restored.name, adapter: restored.adapter },
      });
      return providerView(restored);
    }

    const provider = await prisma.deliveryProvider.create({
      data: { organizationId, name: dto.name, ...fields },
    });
    await auditService.record({
      action: 'delivery_provider.created',
      entityType: 'DeliveryProvider',
      entityId: provider.id,
      after: { name: provider.name, adapter: provider.adapter },
    });
    return providerView(provider);
  },

  async updateProvider(id: string, dto: z.infer<typeof updateProviderSchema>) {
    const existing = await prisma.deliveryProvider.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundError('Delivery gateway');
    if (dto.isDefault) {
      await prisma.deliveryProvider.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
    }

    // Merge credentials rather than replace: the client only ever sends the
    // secrets it is actually changing, because it never receives the others.
    const credentials = dto.credentials
      ? { ...((existing.credentials as Record<string, unknown>) ?? {}), ...dto.credentials }
      : undefined;

    const provider = await prisma.deliveryProvider.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.adapter === undefined ? {} : { adapter: dto.adapter }),
        ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
        ...(dto.isDefault === undefined ? {} : { isDefault: dto.isDefault }),
        ...(credentials ? { credentials: credentials as Prisma.InputJsonValue } : {}),
        ...(dto.settings ? { settings: dto.settings as Prisma.InputJsonValue } : {}),
      },
    });
    await auditService.record({
      action: 'delivery_provider.updated',
      entityType: 'DeliveryProvider',
      entityId: id,
      after: { name: provider.name, isActive: provider.isActive, isDefault: provider.isDefault },
    });
    return providerView(provider);
  },

  async removeProvider(id: string) {
    const provider = await prisma.deliveryProvider.findFirst({ where: { id, deletedAt: null } });
    if (!provider) throw new NotFoundError('Delivery gateway');
    // Shipments keep pointing at it, so it is retired rather than removed —
    // the tracking history of past deliveries has to stay intact.
    await prisma.deliveryProvider.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, isDefault: false },
    });
    await auditService.record({
      action: 'delivery_provider.removed',
      entityType: 'DeliveryProvider',
      entityId: id,
      before: { name: provider.name },
    });
    return { id, removed: true };
  },

  /** Reveal the callback URL + secret once, for pasting into the courier's dashboard. */
  async webhookCredentials(id: string) {
    const provider = await prisma.deliveryProvider.findFirst({ where: { id, deletedAt: null } });
    if (!provider) throw new NotFoundError('Delivery gateway');
    let secret = provider.webhookSecret;
    if (!secret) {
      secret = randomBytes(24).toString('hex');
      await prisma.deliveryProvider.update({ where: { id }, data: { webhookSecret: secret } });
    }
    return {
      path: `/api/v1/delivery/webhook/${id}`,
      secret,
      signatureHeader: 'x-vhicasar-signature',
      help: 'Sign the raw JSON body with HMAC-SHA256 using this secret and send it in the header above.',
    };
  },

  async rotateWebhookSecret(id: string) {
    const provider = await prisma.deliveryProvider.findFirst({ where: { id, deletedAt: null } });
    if (!provider) throw new NotFoundError('Delivery gateway');
    const secret = randomBytes(24).toString('hex');
    await prisma.deliveryProvider.update({ where: { id }, data: { webhookSecret: secret } });
    await auditService.record({
      action: 'delivery_provider.secret_rotated',
      entityType: 'DeliveryProvider',
      entityId: id,
    });
    return { id, secret };
  },

  // -------------------------------------------------------------- dispatch

  async shipmentsForOrder(orderId: string) {
    const rows = await prisma.shipment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      include: {
        provider: { select: { id: true, name: true, adapter: true } },
        events: { orderBy: { occurredAt: 'desc' }, take: 50 },
      },
    });
    return rows.map((s) => ({
      ...shipmentView(s),
      provider: s.provider ? { id: s.provider.id, name: s.provider.name, adapter: s.provider.adapter } : null,
      events: s.events.map((e) => ({
        id: e.id,
        status: e.status,
        statusLabel: SHIPMENT_LABEL[e.status],
        description: e.description,
        location: e.location,
        source: e.source,
        occurredAt: e.occurredAt,
      })),
    }));
  },

  /**
   * Book a delivery for an order. The gateway adapter is called first; only a
   * successful booking creates the shipment, so a courier outage leaves no
   * phantom "dispatched" record behind.
   */
  async dispatchOrder(orderId: string, dto: DispatchDto, actorUserId?: string) {
    const organizationId = currentOrgId();
    const order = await prisma.order.findFirst({
      where: { id: orderId },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
        shippingAddress: true,
        _count: { select: { items: true } },
      },
    });
    if (!order) throw new NotFoundError('Order');
    if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
      throw new ConflictError('This order is cancelled — there is nothing to deliver.');
    }

    const provider = dto.providerId
      ? await prisma.deliveryProvider.findFirst({ where: { id: dto.providerId, deletedAt: null } })
      : await prisma.deliveryProvider.findFirst({ where: { deletedAt: null, isActive: true, isDefault: true } });
    if (!provider) {
      throw new AppError(
        'NO_DELIVERY_GATEWAY',
        400,
        'Connect a delivery gateway first, in Settings → Integrations → Delivery.'
      );
    }
    if (!provider.isActive) throw new ConflictError(`${provider.name} is turned off.`);

    const composedAddress = [
      order.shippingAddress?.addressLine1,
      order.shippingAddress?.addressLine2,
      order.shippingAddress?.city,
      order.shippingAddress?.state,
    ]
      .filter(Boolean)
      .join(', ');
    const address = dto.dropoffAddress ?? (composedAddress || null);
    const composedName = [order.customer.firstName, order.customer.lastName].filter(Boolean).join(' ');
    const recipientName = dto.recipientName ?? (composedName || null);

    const adapter = getAdapter(provider.adapter);
    const booking = await adapter.book(
      {
        reference: order.number,
        amount: order.total.toFixed(2),
        currency: order.currency,
        recipientName,
        recipientPhone: dto.recipientPhone ?? order.customer.phone ?? null,
        dropoffAddress: address,
        pickupAddress: dto.pickupAddress ?? null,
        notes: dto.notes ?? null,
        itemCount: order._count.items,
      },
      {
        credentials: (provider.credentials as Record<string, unknown>) ?? {},
        settings: (provider.settings as Record<string, unknown>) ?? {},
      }
    );

    const shipment = await prisma.shipment.create({
      data: {
        organizationId,
        orderId,
        number: await nextShipmentNumber(organizationId),
        status: booking.status,
        statusDetail: booking.statusDetail,
        carrier: dto.carrier ?? provider.name,
        providerId: provider.id,
        externalId: booking.externalId,
        // A manually supplied tracking number wins: the operator typed what the
        // courier actually gave them.
        trackingNumber: dto.trackingNumber ?? booking.trackingNumber,
        trackingUrl: dto.trackingUrl ?? booking.trackingUrl,
        labelUrl: booking.labelUrl,
        cost: booking.cost ?? null,
        currency: booking.currency ?? order.currency,
        shippingAddressId: order.shippingAddressId,
        recipientName,
        recipientPhone: dto.recipientPhone ?? order.customer.phone ?? null,
        dropoffAddress: address,
        pickupAddress: dto.pickupAddress ?? null,
        notes: dto.notes ?? null,
        estimatedAt: booking.estimatedAt,
        lastSyncedAt: new Date(),
        ...(booking.status === 'PICKED_UP' || booking.status === 'IN_TRANSIT' ? { shippedAt: new Date() } : {}),
      },
    });

    await prisma.deliveryEvent.create({
      data: {
        organizationId,
        shipmentId: shipment.id,
        status: booking.status,
        description: `Booked with ${provider.name}`,
        source: 'MANUAL',
        raw: booking.raw ? (booking.raw as Prisma.InputJsonValue) : undefined,
      },
    });

    await prisma.deliveryProvider.update({ where: { id: provider.id }, data: { lastUsedAt: new Date() } });
    // Dispatching is itself the signal that this order needs delivering.
    if (!order.requiresDelivery) {
      await prisma.order.update({ where: { id: orderId }, data: { requiresDelivery: true } });
    }

    await this.projectOntoOrder(orderId, booking.status, actorUserId, `Delivery booked with ${provider.name}`);
    await auditService.record({
      action: 'delivery.dispatched',
      entityType: 'Shipment',
      entityId: shipment.id,
      after: { order: order.number, provider: provider.name, tracking: shipment.trackingNumber },
    });
    await emitEvent({
      name: 'ShipmentCreated',
      aggregateType: 'Shipment',
      aggregateId: shipment.id,
      payload: { orderId, provider: provider.name, trackingNumber: shipment.trackingNumber },
      organizationId,
    });
    await this.announce(shipment.id, booking.status, `Booked with ${provider.name}`);

    return shipmentView(shipment);
  },

  /** Move a delivery on by hand — own riders, or a courier that phones in. */
  async setShipmentStatus(shipmentId: string, dto: z.infer<typeof shipmentStatusSchema>, actorUserId?: string) {
    const organizationId = currentOrgId();
    const shipment = await prisma.shipment.findFirst({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundError('Shipment');

    const updated = await prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        status: dto.status,
        statusDetail: dto.description ?? null,
        ...(dto.trackingNumber ? { trackingNumber: dto.trackingNumber } : {}),
        ...(dto.trackingUrl ? { trackingUrl: dto.trackingUrl } : {}),
        ...(dto.status === 'PICKED_UP' && !shipment.shippedAt ? { shippedAt: new Date() } : {}),
        ...(dto.status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
        lastSyncedAt: new Date(),
      },
    });

    await prisma.deliveryEvent.create({
      data: {
        organizationId,
        shipmentId,
        status: dto.status,
        description: dto.description ?? SHIPMENT_LABEL[dto.status],
        location: dto.location ?? null,
        source: 'MANUAL',
      },
    });

    await this.projectOntoOrder(shipment.orderId, dto.status, actorUserId, dto.description);
    await this.announce(shipmentId, dto.status, dto.description);
    return shipmentView(updated);
  },

  // --------------------------------------------------------------- webhooks

  /**
   * Tracking callback from a courier. Unauthenticated by design — the gateway
   * has no session — so the shared secret is the only thing standing between a
   * stranger and an order's status, and an unsigned or mis-signed body is
   * rejected outright.
   */
  async handleWebhook(providerId: string, rawBody: string, signature: string | undefined) {
    const provider = await prismaUnscoped.deliveryProvider.findFirst({
      where: { id: providerId, deletedAt: null },
    });
    if (!provider) throw new NotFoundError('Delivery gateway');
    if (!provider.webhookSecret) {
      throw new AppError('WEBHOOK_NOT_CONFIGURED', 400, 'This gateway has no webhook secret.');
    }
    if (!verifySignature(rawBody, signature, provider.webhookSecret)) {
      throw new AppError('INVALID_SIGNATURE', 401, 'Signature does not match.');
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new ValidationError('Body is not valid JSON.');
    }

    const settings = (provider.settings as Record<string, unknown>) ?? {};
    const field = (...names: string[]): string | null => {
      for (const n of names) {
        const v = body[n];
        if (v !== undefined && v !== null && v !== '') return String(v);
      }
      return null;
    };

    const externalId = field('id', 'delivery_id', 'deliveryId', 'shipment_id');
    const reference = field('reference', 'order_reference', 'tracking_number', 'trackingNumber');
    const shipment = await prismaUnscoped.shipment.findFirst({
      where: {
        organizationId: provider.organizationId,
        OR: [
          ...(externalId ? [{ providerId, externalId }] : []),
          ...(reference ? [{ trackingNumber: reference }, { number: reference }] : []),
          ...(reference ? [{ order: { number: reference } }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!shipment) throw new NotFoundError('Shipment');

    const rawStatus = field('status', 'event', 'state');
    const status = mapCarrierStatus(rawStatus, parseStatusMap(settings.statusMap));
    if (!status) {
      // Better to say we didn't understand than to silently drop a status the
      // business is relying on.
      throw new AppError(
        'UNKNOWN_DELIVERY_STATUS',
        422,
        `Unrecognised status "${rawStatus ?? ''}". Add it to this gateway's status mapping.`
      );
    }

    const eventId = field('event_id', 'eventId');
    if (eventId) {
      const seen = await prismaUnscoped.deliveryEvent.findFirst({
        where: { shipmentId: shipment.id, externalEventId: eventId },
        select: { id: true },
      });
      // Couriers retry; replaying an event must not re-notify the customer.
      if (seen) return { shipmentId: shipment.id, status: shipment.status, duplicate: true };
    }

    await prismaUnscoped.deliveryEvent.create({
      data: {
        organizationId: provider.organizationId,
        shipmentId: shipment.id,
        status,
        description: field('description', 'message', 'note') ?? SHIPMENT_LABEL[status],
        location: field('location', 'city'),
        externalEventId: eventId,
        source: 'WEBHOOK',
        raw: body as Prisma.InputJsonValue,
      },
    });

    await prismaUnscoped.shipment.update({
      where: { id: shipment.id },
      data: {
        status,
        statusDetail: rawStatus,
        ...(externalId && !shipment.externalId ? { externalId } : {}),
        ...(status === 'PICKED_UP' && !shipment.shippedAt ? { shippedAt: new Date() } : {}),
        ...(status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
        lastSyncedAt: new Date(),
      },
    });

    await this.projectOntoOrder(shipment.orderId, status, undefined, field('description', 'message'));
    await this.announce(shipment.id, status, field('description', 'message'));
    return { shipmentId: shipment.id, status, duplicate: false };
  },

  // ---------------------------------------------------------------- shared

  /**
   * Reflect a delivery stage onto the order. Only ever forward, and never over
   * a terminal state, so a late callback can't resurrect a cancelled order.
   */
  async projectOntoOrder(
    orderId: string,
    shipmentStatus: ShipmentStatus,
    actorUserId?: string,
    note?: string | null
  ) {
    const target = SHIPMENT_TO_ORDER[shipmentStatus];
    if (!target) return;

    const order = await prismaUnscoped.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, number: true, organizationId: true, customerId: true },
    });
    if (!order) return;
    if (order.status === 'CANCELLED' || order.status === 'REFUNDED' || order.status === 'COMPLETED') return;
    if (ORDER_RANK[target] <= ORDER_RANK[order.status]) return;

    await prismaUnscoped.order.update({
      where: { id: orderId },
      data: {
        status: target,
        ...(target === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
        statusHistory: {
          create: {
            fromStatus: order.status,
            toStatus: target,
            actorUserId: actorUserId ?? null,
            note: note ?? 'Updated by the delivery gateway',
          },
        },
      },
    });

    broadcast({
      event: 'order.status',
      payload: { orderId, number: order.number, status: target, source: 'delivery' },
      organizationId: order.organizationId,
    });
    await emitEvent({
      name: 'OrderStatusChanged',
      aggregateType: 'Order',
      aggregateId: orderId,
      payload: { from: order.status, to: target, source: 'delivery' },
      organizationId: order.organizationId,
    });
  },

  /** Tell the customer and the business dashboard where their parcel is. */
  async announce(shipmentId: string, status: ShipmentStatus, description?: string | null) {
    try {
      const shipment = await prismaUnscoped.shipment.findUnique({
        where: { id: shipmentId },
        select: {
          id: true,
          number: true,
          organizationId: true,
          trackingNumber: true,
          trackingUrl: true,
          order: { select: { id: true, number: true, customerId: true } },
        },
      });
      if (!shipment) return;

      broadcast({
        event: 'shipment.status',
        payload: {
          shipmentId,
          orderId: shipment.order.id,
          status,
          statusLabel: SHIPMENT_LABEL[status],
        },
        organizationId: shipment.organizationId,
      });

      const link = await prismaUnscoped.customerLink.findUnique({
        where: { customerId: shipment.order.customerId },
        select: { vhicasarId: true },
      });
      // Not every customer is on the Super App; a local-only customer simply
      // has no one to notify.
      if (!link) return;

      await notifyCustomer({
        vhicasarId: link.vhicasarId,
        organizationId: shipment.organizationId,
        category: 'ORDER',
        title: `${SHIPMENT_LABEL[status]} — order ${shipment.order.number}`,
        body: description ?? (shipment.trackingNumber ? `Tracking ${shipment.trackingNumber}` : undefined),
        deeplink: `vhicasar://business/${shipment.organizationId}/order/${shipment.order.id}`,
        data: { shipmentId, status, trackingUrl: shipment.trackingUrl ?? '' },
      });
    } catch (err) {
      // Notification failure must never undo a delivery update.
      logger.warn({ err, shipmentId }, 'delivery notification failed');
    }
  },
};

function verifySignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  // Some gateways prefix the scheme; compare against the hex either way.
  const provided = signature.includes('=') ? (signature.split('=').pop() ?? '') : signature;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided.trim(), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export { SHIPMENT_LABEL, isShipmentStatus };
